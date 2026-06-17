import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';

interface ImageItem {
	src: string;
	alt: string;
	name: string;
}

type ThumbnailOrientation = 'landscape' | 'portrait' | 'square';
type WheelMode = 'zoom' | 'navigate';

// How an image is scaled when it first opens.
//   fit-down — fit the window without enlarging small images (current default)
//   fit      — fit the window, enlarging small images to fill it
//   height   — scale so the image height fills the window (width may overflow)
//   width    — scale so the image width fills the window (height may overflow)
//   actual   — show at 100% (natural pixel size)
type DefaultZoom = 'fit-down' | 'fit' | 'height' | 'width' | 'actual';

interface ImageViewerSettings {
	showThumbnails: boolean;
	thumbnailHeight: number;
	thumbnailOrientation: ThumbnailOrientation;
	centerThumbnails: boolean;
	showArrows: boolean;
	showFilename: boolean;
	wheelMode: WheelMode;
	defaultZoom: DefaultZoom;
	backdropOpacity: number;
	minZoom: number;
	maxZoom: number;
	zoomStep: number;
	keepZoom: boolean;
	loop: boolean;
	closeOnBackdropClick: boolean;
}

const DEFAULT_SETTINGS: ImageViewerSettings = {
	showThumbnails: true,
	thumbnailHeight: 64,
	thumbnailOrientation: 'landscape',
	centerThumbnails: false,
	showArrows: true,
	showFilename: true,
	wheelMode: 'zoom',
	defaultZoom: 'fit-down',
	backdropOpacity: 0.92,
	minZoom: 0.2,
	maxZoom: 12,
	zoomStep: 1.15,
	keepZoom: false,
	loop: true,
	closeOnBackdropClick: true,
};

// Thumbnails keep a fixed ~4:3 aspect so they all look uniform.
const THUMB_ASPECT = 84 / 64;

export default class ImageViewerPlugin extends Plugin {
	settings: ImageViewerSettings = DEFAULT_SETTINGS;
	private viewer: ImageViewer | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new ImageViewerSettingTab(this.app, this));

		// Capture phase so we intercept the click before the editor/preview handles it.
		this.registerDomEvent(document, 'click', this.handleClick, { capture: true });
	}

	onunload(): void {
		this.viewer?.close();
		this.viewer = null;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private handleClick = (evt: MouseEvent): void => {
		const target = evt.target;
		if (!(target instanceof HTMLImageElement)) return;

		// Never react to clicks inside our own overlay.
		if (target.closest('.image-viewer-overlay')) return;

		// Only handle images rendered inside a note/view.
		const container = target.closest('.view-content');
		if (!container) return;

		const images = Array.from(container.querySelectorAll('img')).filter(
			(img) => !!(img.currentSrc || img.src),
		);
		if (images.length === 0) return;

		const index = images.indexOf(target);
		if (index < 0) return;

		evt.preventDefault();
		evt.stopPropagation();

		const items: ImageItem[] = images.map((img) => {
			const src = img.currentSrc || img.src;
			const alt = img.alt || '';
			return { src, alt, name: fileNameFromSrc(src, alt) };
		});

		this.openViewer(items, index);
	};

	private openViewer(items: ImageItem[], index: number): void {
		this.viewer?.close();
		this.viewer = new ImageViewer(items, index, this.settings, () => {
			this.viewer = null;
		});
		this.viewer.open();
	}
}

class ImageViewer {
	private readonly items: ImageItem[];
	private index: number;
	private readonly settings: ImageViewerSettings;
	private readonly onClose: () => void;

	private overlay: HTMLElement | null = null;
	private stage!: HTMLElement;
	private mainImg!: HTMLImageElement;
	private thumbStrip!: HTMLElement;
	private counterEl!: HTMLElement;
	private nameEl!: HTMLElement;
	private prevBtn!: HTMLButtonElement;
	private nextBtn!: HTMLButtonElement;
	private readonly thumbs: HTMLElement[] = [];

	// Zoom / pan state for the current image. `scale` is the absolute transform
	// scale applied to the image's natural size; `baseScale` is the scale chosen
	// by the default-zoom mode (the "home" zoom we reset to).
	private scale = 1;
	private baseScale = 1;
	private tx = 0;
	private ty = 0;
	private pannable = false;
	private firstRender = true;

	// Accumulates wheel delta so one "notch" advances one image (trackpad-friendly).
	private wheelAccum = 0;

	private isPanning = false;
	private panStartX = 0;
	private panStartY = 0;
	private panOriginX = 0;
	private panOriginY = 0;
	private moved = false;

	private closed = false;

	constructor(
		items: ImageItem[],
		index: number,
		settings: ImageViewerSettings,
		onClose: () => void,
	) {
		this.items = items;
		this.index = index;
		this.settings = settings;
		this.onClose = onClose;
	}

	open(): void {
		const overlay = document.body.createDiv({ cls: 'image-viewer-overlay' });
		this.overlay = overlay;

		// Apply settings that affect layout via inline styles / CSS variables.
		overlay.style.backgroundColor = `rgba(0, 0, 0, ${this.settings.backdropOpacity})`;
		const thumbHeight = this.settings.thumbnailHeight;
		let thumbWidth: number;
		switch (this.settings.thumbnailOrientation) {
			case 'portrait':
				thumbWidth = Math.round(thumbHeight / THUMB_ASPECT);
				break;
			case 'square':
				thumbWidth = thumbHeight;
				break;
			default:
				thumbWidth = Math.round(thumbHeight * THUMB_ASPECT);
		}
		overlay.style.setProperty('--iv-thumb-h', `${thumbHeight}px`);
		overlay.style.setProperty('--iv-thumb-w', `${thumbWidth}px`);

		const multiple = this.items.length > 1;
		const showArrows = this.settings.showArrows && multiple;
		const showThumbs = this.settings.showThumbnails && multiple;
		if (!showArrows) overlay.addClass('image-viewer-no-arrows');
		if (!showThumbs) overlay.addClass('image-viewer-no-thumbs');
		if (this.settings.centerThumbnails) overlay.addClass('image-viewer-center-thumbs');

		// Top bar: counter + close button.
		const topbar = overlay.createDiv({ cls: 'image-viewer-topbar' });
		this.counterEl = topbar.createDiv({ cls: 'image-viewer-counter' });
		this.nameEl = topbar.createDiv({ cls: 'image-viewer-filename' });
		if (!this.settings.showFilename) this.nameEl.hide();
		const closeBtn = topbar.createEl('button', {
			cls: 'image-viewer-btn image-viewer-close',
			text: '✕',
			attr: { 'aria-label': 'Close (Esc)' },
		});
		closeBtn.addEventListener('click', () => this.close());
		// The backdrop already closes the viewer, so the cross is redundant.
		if (this.settings.closeOnBackdropClick) closeBtn.hide();

		// Stage holds the main image + nav arrows.
		this.stage = overlay.createDiv({ cls: 'image-viewer-stage' });
		this.mainImg = this.stage.createEl('img', { cls: 'image-viewer-main' });
		this.mainImg.draggable = false;
		// Natural size is only known once the image has loaded.
		this.mainImg.addEventListener('load', this.onImageLoad);

		this.prevBtn = this.stage.createEl('button', {
			cls: 'image-viewer-btn image-viewer-nav image-viewer-prev',
			text: '‹',
			attr: { 'aria-label': 'Previous (←)' },
		});
		this.nextBtn = this.stage.createEl('button', {
			cls: 'image-viewer-btn image-viewer-nav image-viewer-next',
			text: '›',
			attr: { 'aria-label': 'Next (→)' },
		});
		this.prevBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.prev();
		});
		this.nextBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.next();
		});

		// Bottom thumbnail gallery.
		this.thumbStrip = overlay.createDiv({ cls: 'image-viewer-thumbnails' });
		this.items.forEach((item, i) => {
			const thumb = this.thumbStrip.createDiv({ cls: 'image-viewer-thumb' });
			const img = thumb.createEl('img', { attr: { src: item.src, alt: item.alt } });
			img.draggable = false;
			thumb.addEventListener('click', (e) => {
				e.stopPropagation();
				this.goTo(i);
			});
			this.thumbs.push(thumb);
		});

		this.registerEvents();
		this.showCurrent();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;

		document.removeEventListener('keydown', this.onKeyDown, true);
		document.removeEventListener('mousemove', this.onMouseMove);
		document.removeEventListener('mouseup', this.onMouseUp);
		window.removeEventListener('resize', this.onResize);

		this.overlay?.remove();
		this.overlay = null;
		this.onClose();
	}

	private registerEvents(): void {
		document.addEventListener('keydown', this.onKeyDown, true);
		document.addEventListener('mousemove', this.onMouseMove);
		document.addEventListener('mouseup', this.onMouseUp);
		window.addEventListener('resize', this.onResize);

		this.stage.addEventListener('wheel', this.onWheel, { passive: false });
		this.stage.addEventListener('mousedown', this.onMouseDown);

		// Click on the dark backdrop (not the image / buttons) closes the viewer.
		this.stage.addEventListener('click', (e) => {
			if (!this.settings.closeOnBackdropClick) return;
			if (e.target === this.stage && !this.moved) this.close();
		});

		// Double click toggles between the default zoom and 2x.
		this.mainImg.addEventListener('dblclick', (e) => {
			e.preventDefault();
			if (Math.abs(this.scale - this.baseScale) > 1e-3) this.resetToBase();
			else this.applyZoom(2, 0, 0);
		});

		// Vertical wheel over the strip scrolls it horizontally.
		this.thumbStrip.addEventListener(
			'wheel',
			(e) => {
				if (e.deltaY === 0) return;
				e.preventDefault();
				this.thumbStrip.scrollLeft += e.deltaY;
			},
			{ passive: false },
		);
	}

	private onKeyDown = (e: KeyboardEvent): void => {
		switch (e.key) {
			case 'Escape':
				e.preventDefault();
				this.close();
				break;
			case 'ArrowRight':
				e.preventDefault();
				this.next();
				break;
			case 'ArrowLeft':
				e.preventDefault();
				this.prev();
				break;
			case '+':
			case '=':
				e.preventDefault();
				this.applyZoom(this.settings.zoomStep, 0, 0);
				break;
			case '-':
			case '_':
				e.preventDefault();
				this.applyZoom(1 / this.settings.zoomStep, 0, 0);
				break;
			case '0':
				e.preventDefault();
				this.resetToBase();
				break;
		}
	};

	private onWheel = (e: WheelEvent): void => {
		e.preventDefault();

		// In 'navigate' mode plain wheel flips images and Ctrl/Cmd+wheel zooms;
		// in 'zoom' mode the wheel always zooms.
		const navigateMode = this.settings.wheelMode === 'navigate';
		const doZoom = navigateMode ? e.ctrlKey || e.metaKey : true;

		if (doZoom) {
			const rect = this.stage.getBoundingClientRect();
			const mx = e.clientX - rect.left - rect.width / 2;
			const my = e.clientY - rect.top - rect.height / 2;
			const factor = e.deltaY < 0 ? this.settings.zoomStep : 1 / this.settings.zoomStep;
			this.applyZoom(factor, mx, my);
			return;
		}

		// Navigate: accumulate delta and step once per threshold crossing.
		if (Math.sign(e.deltaY) !== Math.sign(this.wheelAccum)) this.wheelAccum = 0;
		this.wheelAccum += e.deltaY;
		const THRESHOLD = 50;
		if (this.wheelAccum >= THRESHOLD) {
			this.wheelAccum = 0;
			this.next();
		} else if (this.wheelAccum <= -THRESHOLD) {
			this.wheelAccum = 0;
			this.prev();
		}
	};

	private onMouseDown = (e: MouseEvent): void => {
		if (e.button !== 0) return;
		this.isPanning = true;
		this.moved = false;
		this.panStartX = e.clientX;
		this.panStartY = e.clientY;
		this.panOriginX = this.tx;
		this.panOriginY = this.ty;
	};

	private onMouseMove = (e: MouseEvent): void => {
		if (!this.isPanning) return;
		const dx = e.clientX - this.panStartX;
		const dy = e.clientY - this.panStartY;
		if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.moved = true;
		if (this.pannable) {
			this.tx = this.panOriginX + dx;
			this.ty = this.panOriginY + dy;
			this.updateTransform();
		}
	};

	private onMouseUp = (): void => {
		this.isPanning = false;
	};

	private applyZoom(factor: number, mx: number, my: number): void {
		// Zoom limits are expressed relative to the default ("base") zoom.
		const minScale = this.baseScale * this.settings.minZoom;
		const maxScale = this.baseScale * this.settings.maxZoom;
		const newScale = clamp(this.scale * factor, minScale, maxScale);
		const ratio = newScale / this.scale;
		// Keep the point under the cursor fixed while zooming.
		this.tx = mx - (mx - this.tx) * ratio;
		this.ty = my - (my - this.ty) * ratio;
		this.scale = newScale;
		this.updateTransform();
	}

	// Compute the "home" scale for the current image from its natural size,
	// the stage size and the configured default-zoom mode.
	private computeBaseScale(): void {
		const sw = this.stage.clientWidth;
		const sh = this.stage.clientHeight;
		const iw = this.mainImg.naturalWidth;
		const ih = this.mainImg.naturalHeight;
		if (!sw || !sh || !iw || !ih) {
			this.baseScale = 1;
			return;
		}
		switch (this.settings.defaultZoom) {
			case 'actual':
				this.baseScale = 1;
				break;
			case 'width':
				this.baseScale = sw / iw;
				break;
			case 'height':
				this.baseScale = sh / ih;
				break;
			case 'fit':
				this.baseScale = Math.min(sw / iw, sh / ih);
				break;
			default: // 'fit-down' — never enlarge beyond natural size
				this.baseScale = Math.min(1, sw / iw, sh / ih);
		}
	}

	private resetToBase(): void {
		this.scale = this.baseScale;
		this.tx = 0;
		this.ty = 0;
		this.updateTransform();
	}

	private updateTransform(): void {
		// The image overflows the stage (and is therefore pannable) when its
		// rendered size exceeds the stage in either dimension.
		const rw = this.mainImg.naturalWidth * this.scale;
		const rh = this.mainImg.naturalHeight * this.scale;
		this.pannable =
			rw > this.stage.clientWidth + 1 || rh > this.stage.clientHeight + 1;
		if (!this.pannable) {
			this.tx = 0;
			this.ty = 0;
		}
		this.mainImg.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
		this.mainImg.toggleClass('is-zoomed', this.pannable);
	}

	private onImageLoad = (): void => {
		this.computeBaseScale();
		// Preserve the current zoom across images only when asked (and never on
		// the very first image, which has no prior zoom to keep).
		if (this.settings.keepZoom && !this.firstRender) {
			this.updateTransform();
		} else {
			this.resetToBase();
		}
		this.firstRender = false;
	};

	private onResize = (): void => {
		// Refit the current image to the new window size.
		this.computeBaseScale();
		this.resetToBase();
	};

	private goTo(index: number): void {
		const count = this.items.length;
		if (this.settings.loop) {
			this.index = ((index % count) + count) % count;
		} else {
			this.index = clamp(index, 0, count - 1);
		}
		this.showCurrent();
	}

	private next(): void {
		this.goTo(this.index + 1);
	}

	private prev(): void {
		this.goTo(this.index - 1);
	}

	private showCurrent(): void {
		const item = this.items[this.index];
		if (!item) return;

		this.mainImg.alt = item.alt;
		this.mainImg.src = item.src;
		this.counterEl.setText(`${this.index + 1} / ${this.items.length}`);
		this.nameEl.setText(item.name);
		this.nameEl.setAttr('title', item.name);
		// Cached images may not fire 'load', so apply the default zoom right away.
		if (this.mainImg.complete && this.mainImg.naturalWidth) this.onImageLoad();

		// Without looping, disable the arrows at the ends.
		if (!this.settings.loop) {
			this.prevBtn.disabled = this.index === 0;
			this.nextBtn.disabled = this.index === this.items.length - 1;
		}

		this.thumbs.forEach((thumb, i) => thumb.toggleClass('is-active', i === this.index));
		this.thumbs[this.index]?.scrollIntoView({
			inline: 'center',
			block: 'nearest',
			behavior: 'smooth',
		});
	}
}

class ImageViewerSettingTab extends PluginSettingTab {
	private readonly plugin: ImageViewerPlugin;

	constructor(app: App, plugin: ImageViewerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Show thumbnail gallery')
			.setDesc('Display the horizontal strip of thumbnails at the bottom.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showThumbnails).onChange(async (value) => {
					this.plugin.settings.showThumbnails = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Thumbnail height')
			.setDesc('Height of each thumbnail in pixels (width scales to keep them uniform).')
			.addSlider((slider) =>
				slider
					.setLimits(40, 160, 4)
					.setValue(this.plugin.settings.thumbnailHeight)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.thumbnailHeight = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Thumbnail orientation')
			.setDesc('Shape of the thumbnails: landscape (wide), portrait (tall) or square.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('landscape', 'Landscape')
					.addOption('portrait', 'Portrait')
					.addOption('square', 'Square')
					.setValue(this.plugin.settings.thumbnailOrientation)
					.onChange(async (value) => {
						this.plugin.settings.thumbnailOrientation = value as ThumbnailOrientation;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Center thumbnail gallery')
			.setDesc('Center the thumbnails when they fit; otherwise they stay left-aligned and scroll.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.centerThumbnails).onChange(async (value) => {
					this.plugin.settings.centerThumbnails = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Show navigation arrows')
			.setDesc('Display the ‹ › arrows over the image (arrow keys always work).')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showArrows).onChange(async (value) => {
					this.plugin.settings.showArrows = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Show file name')
			.setDesc('Show the current image file name in the top bar.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showFilename).onChange(async (value) => {
					this.plugin.settings.showFilename = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Mouse wheel')
			.setDesc(
				'How the scroll wheel behaves inside the viewer. ' +
					'Arrow keys always navigate regardless of this setting.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('zoom', 'Zoom (arrows navigate)')
					.addOption('navigate', 'Navigate (Ctrl+wheel zooms)')
					.setValue(this.plugin.settings.wheelMode)
					.onChange(async (value) => {
						this.plugin.settings.wheelMode = value as WheelMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Default zoom')
			.setDesc('How an image is scaled when it first opens.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('fit-down', 'Fit window (no upscaling)')
					.addOption('fit', 'Fit window (maximize)')
					.addOption('height', 'Fill height')
					.addOption('width', 'Fill width')
					.addOption('actual', 'Actual size (100%)')
					.setValue(this.plugin.settings.defaultZoom)
					.onChange(async (value) => {
						this.plugin.settings.defaultZoom = value as DefaultZoom;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Keep zoom between images')
			.setDesc('Preserve the current zoom level and position when switching images.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.keepZoom).onChange(async (value) => {
					this.plugin.settings.keepZoom = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Loop navigation')
			.setDesc('Wrap around from the last image to the first and vice versa.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.loop).onChange(async (value) => {
					this.plugin.settings.loop = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Close on backdrop click')
			.setDesc('Click the dark area around the image to close the viewer.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.closeOnBackdropClick).onChange(async (value) => {
					this.plugin.settings.closeOnBackdropClick = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Backdrop opacity')
			.setDesc('How dark the background behind the image is.')
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 1, 0.02)
					.setValue(this.plugin.settings.backdropOpacity)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.backdropOpacity = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Minimum zoom')
			.setDesc('Lower limit for zoom — values below 1.0 let you shrink below the default size.')
			.addSlider((slider) =>
				slider
					.setLimits(0.1, 1, 0.05)
					.setValue(this.plugin.settings.minZoom)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.minZoom = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Maximum zoom')
			.setDesc('Upper limit for mouse-wheel zoom (× the default size).')
			.addSlider((slider) =>
				slider
					.setLimits(2, 20, 1)
					.setValue(this.plugin.settings.maxZoom)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxZoom = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Zoom step')
			.setDesc('Wheel sensitivity — how much each notch zooms.')
			.addSlider((slider) =>
				slider
					.setLimits(1.05, 1.5, 0.05)
					.setValue(this.plugin.settings.zoomStep)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.zoomStep = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// Derive a human-readable file name from an image URL, falling back to alt text.
function fileNameFromSrc(src: string, fallback: string): string {
	try {
		const path = src.split(/[?#]/)[0];
		const segment = path.substring(path.lastIndexOf('/') + 1);
		const name = decodeURIComponent(segment);
		return name || fallback;
	} catch {
		return fallback;
	}
}
