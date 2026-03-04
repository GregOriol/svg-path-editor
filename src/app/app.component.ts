import { Component, AfterViewInit, HostListener, ViewChild } from '@angular/core';
import { trigger, state, style, animate, transition } from '@angular/animations';
import { SvgPath, SvgItem, Point, SvgPoint, SvgControlPoint, formatNumber } from '../lib/svg';
import type { SvgCommandType, SvgCommandTypeAny } from '../lib/svg-command-types';
import { MatIconRegistry } from '@angular/material/icon';
import { DomSanitizer } from '@angular/platform-browser';
import { StorageService } from './storage.service';
import { CanvasComponent } from './canvas/canvas.component';
import { Image } from './image';
import { UploadImageComponent } from './upload-image/upload-image.component';
import { ConfigService } from './config.service';
import { browserComputePathBoundingBox } from './svg-bbox';
import { reversePath } from '../lib/reverse-path';
import { optimizePath } from '../lib/optimize-path';
import { changePathOrigin } from 'src/lib/change-path-origin';
import { KEYBOARD } from './constants/keyboard.const';

export const kDefaultPath = `M 32\u00b110 -4\u00b110 S 86 6 86\u00b15 50\u00b15 @sineEaseIn C 86 57 87 80 50\u00b15 80\u00b15 @sineEaseOut C 23 80 20 60 20\u00b15 50\u00b15 C 20 40 35 30 50\u00b15 30\u00b15 C 67 30 76 51 66 61 C 59 68 39 66 50\u00b15 50\u00b15`;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  animations: [
    trigger('leftColumnParent', [
      transition(':enter', [])
    ]),
    trigger('leftColumn', [
      state('*', style({'max-width': '310px'})),
      transition(':enter', [style({'max-width': '0'}), animate('100ms ease')]),
      transition(':leave', [animate('100ms ease', style({'max-width': '0'}))])
    ])
  ]
})
export class AppComponent implements AfterViewInit {
  // SvgPath path data model:
  parsedPath: SvgPath;
  targetPoints: SvgPoint[] = [];
  controlPoints: SvgControlPoint[] = [];

  // Raw path:
  _rawPath = this.storage.getPath()?.path || kDefaultPath;
  pathName = '';
  invalidSyntax = false;

  // Undo/redo
  history: string[] = [];
  historyCursor = -1;
  historyDisabled = false;

  //  Path operations panel inputs:
  scaleX = 1;
  scaleY = 1;
  translateX = 0;
  translateY = 0;
  rotateX = 0;
  rotateY = 0;
  rotateAngle = 0;
  roundValuesDecimals = 1;

  // Canvas Data:
  @ViewChild(CanvasComponent) canvas?: CanvasComponent;
  canvasWidth = 100;
  canvasHeight = 100;
  strokeWidth = 1;

  // Dragged & hovered elements
  draggedPoint: SvgPoint | null = null;
  focusedItem: SvgItem | null = null;
  hoveredItem: SvgItem | null = null;
  wasCanvasDragged = false;
  draggedIsNew = false;
  dragging = false;
	cursorPosition?: Point & {decimals?: number};
	hoverPosition?: Point;

  // Images
  images: Image[] = [];
  focusedImage: Image | null = null;

  // UI State
  isLeftPanelOpened = true;
  isContextualMenuOpened = false;
  isEditingImages = false;
  showingAppPath = false;
  appPathString = '';
  private isImportingFromApp = false;

  // Utility functions:
  max = Math.max;
  trackByIndex = (idx: number, _: unknown) => idx;
  formatNumber = (v: number) => formatNumber(v, 4);

  constructor(
    matRegistry: MatIconRegistry,
    sanitizer: DomSanitizer,
    public cfg: ConfigService,
    private storage: StorageService
  ) {
    for (const icon of ['delete', 'logo', 'more', 'github', 'zoom_in', 'zoom_out', 'zoom_fit', 'sponsor']) {
      matRegistry.addSvgIcon(icon, sanitizer.bypassSecurityTrustResourceUrl(`./assets/${icon}.svg`));
    }
    this.parsedPath = new SvgPath('');
    this.reloadPath(this.rawPath, true);
  }

  @HostListener('document:keydown', ['$event']) onKeyDown($event: KeyboardEvent) {
    const tag = $event.target instanceof Element ? $event.target.tagName : null;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      if ($event.shiftKey && ($event.metaKey || $event.ctrlKey) && $event.key.toLowerCase() === KEYBOARD.KEYS.UNDO) {
        this.redo();
        $event.preventDefault();
      } else if (($event.metaKey || $event.ctrlKey) && $event.key.toLowerCase() === KEYBOARD.KEYS.UNDO) {
        this.undo();
        $event.preventDefault();
      } else if (!$event.metaKey && !$event.ctrlKey && KEYBOARD.PATTERNS.SVG_COMMAND.test($event.key)) {
        const isLower = $event.key === $event.key.toLowerCase();
        const key = $event.key.toUpperCase() as SvgCommandType;
        if (isLower) {
          // Item insertion
          const lastItem = this.parsedPath.path.length ?  this.parsedPath.path[this.parsedPath.path.length - 1] : null;
          const prevItem = this.focusedItem || lastItem;
          if(this.canInsertAfter(prevItem, key)) {
            this.insert(key, prevItem, false);
            $event.preventDefault();
          }
        } else if (!isLower && this.focusedItem && this.canConvert(this.focusedItem, key)) {
          // Item conversion
          this.insert(key, this.focusedItem, true);
          $event.preventDefault();
        }
      } else if (!$event.metaKey && !$event.ctrlKey && $event.key === KEYBOARD.KEYS.ESCAPE) {
        if (this.dragging) {
          // If an element is being dragged, undo by reloading the current history entry
          this.reloadPath(this.history[this.historyCursor]);
        } else if(this.canvas){
          // stopDrag will unselect selected item if any
          this.canvas.stopDrag();
        }
        $event.preventDefault();
      } else if (!$event.metaKey && !$event.ctrlKey && ($event.key === KEYBOARD.KEYS.DELETE || $event.key === KEYBOARD.KEYS.BACKSPACE)) {
        if (this.focusedItem && this.canDelete(this.focusedItem)) {
          this.delete(this.focusedItem);
          $event.preventDefault();
        }
        if (this.focusedImage) {
          this.deleteImage(this.focusedImage);
          $event.preventDefault();
        }
      }
    }
  }
  get decimals() {
    return  this.cfg.snapToGrid ? 0 : this.cfg.decimalPrecision;
 }

  ngAfterViewInit() {
    setTimeout(() => {
      this.zoomAuto();
    }, 0);
  }

  get rawPath(): string {
    return this._rawPath;
  }
  set rawPath(value: string) {
      this._rawPath = value;
      this.pushHistory();
  }

  setIsDragging(dragging: boolean) {
    this.dragging = dragging;
    this.setHistoryDisabled(dragging);
    if (!dragging) {
      this.draggedIsNew = false;
    }
  }

	setCursorPosition(position?: Point & {decimals?: number}) {
		this.cursorPosition = position;
	}

	setHoverPosition(position?: Point) {
		this.hoverPosition = position;
	}

  setHistoryDisabled(value: boolean) {
    this.historyDisabled = value;
    if (!value) {
      this.pushHistory();
    }
  }

  pushHistory() {
    if (!this.historyDisabled && this.rawPath !== this.history[this.historyCursor]) {
      this.historyCursor ++;
      this.history.splice(this.historyCursor, this.history.length - this.historyCursor, this.rawPath);
      this.storage.addPath(null, this.rawPath);
    }
  }

  canUndo(): boolean {
    return this.historyCursor > 0 && !this.isEditingImages;
  }

  undo() {
    if (this.canUndo()) {
      this.historyDisabled = true;
      this.historyCursor --;
      this.reloadPath(this.history[this.historyCursor]);
      this.historyDisabled = false;
    }
  }

  canRedo(): boolean {
    return this.historyCursor < this.history.length - 1 && !this.isEditingImages;
  }

  redo() {
    if (this.canRedo()) {
      this.historyDisabled = true;
      this.historyCursor ++;
      this.reloadPath(this.history[this.historyCursor]);
      this.historyDisabled = false;
    }
  }

  updateViewPort(x: number, y: number, w: number | null, h: number | null, force = false) {
    if (!force && this.cfg.viewPortLocked) {
      return;
    }
    if (w === null && h !==null) {
      w = this.canvasWidth * h / this.canvasHeight;
    }
    if (h === null && w !==null) {
      h = this.canvasHeight * w / this.canvasWidth;
    }
    if (!w || !h) {
      return;
    }

    this.cfg.viewPortX = parseFloat((1 * x).toPrecision(6));
    this.cfg.viewPortY = parseFloat((1 * y).toPrecision(6));
    this.cfg.viewPortWidth = parseFloat((1 * w).toPrecision(4));
    this.cfg.viewPortHeight = parseFloat((1 * h).toPrecision(4));
    this.strokeWidth = this.cfg.viewPortWidth / this.canvasWidth;
  }

  insert(type: SvgCommandTypeAny, after: SvgItem | null, convert: boolean) {
    if (convert) {
      if(after) {
        this.focusedItem =
          this.parsedPath.changeType(after, (after.relative ? type.toLowerCase() as SvgCommandTypeAny : type));
        this.afterModelChange();
      }
    } else {
      this.draggedIsNew = true;
      const pts = this.targetPoints;
      let point1: Point;

      let newItem: SvgItem | null = null;
      if (after) {
        point1 = after.targetLocation();
      } else if (pts.length === 0) {
        newItem = SvgItem.Make(['M', '0', '0']);
        this.parsedPath.insert(newItem);
        point1 = new Point(0, 0);
      } else {
        point1 = pts[pts.length - 1];
      }

      if (type.toLowerCase() !== 'm' || !newItem) {
        const relative = type.toLowerCase() === type;
        const X = (relative ?  0 : point1.x).toString();
        const Y = (relative ?  0 : point1.y).toString();
        switch (type.toLocaleLowerCase()) {
          case 'm': case 'l': case 't':
            newItem = SvgItem.Make([type, X, Y]) ; break;
          case 'h':
            newItem = SvgItem.Make([type, X]) ; break;
          case 'v':
            newItem = SvgItem.Make([type, Y]) ; break;
          case 's': case 'q':
            newItem = SvgItem.Make([type, X , Y, X, Y]) ; break;
          case 'c':
            newItem = SvgItem.Make([type, X , Y, X, Y, X, Y]) ; break;
          case 'a':
            newItem = SvgItem.Make([type, '1' , '1', '0', '0', '0', X, Y]) ; break;
          case 'z':
            newItem = SvgItem.Make([type]);
        }
        if(newItem) {
          this.parsedPath.insert(newItem, after ?? undefined);
        }
      }
      this.setHistoryDisabled(true);
      this.afterModelChange();

      if(newItem) {
        this.focusedItem = newItem;
        this.draggedPoint = newItem.targetLocation();
      }
    }
  }

  zoomAuto() {
    if (this.cfg.viewPortLocked) {
      return;
    }
    const bbox = browserComputePathBoundingBox(this.parsedPath.asString(4, false));

    const k = this.canvasHeight / this.canvasWidth;
    let w = bbox.width + 2;
    let h = bbox.height + 2;
    if (k < h / w) {
      w = h / k;
    } else {
      h = k * w;
    }

    this.updateViewPort(
      bbox.x - 1,
      bbox.y - 1,
      w,
      h
    );
  }

  scale(x: number, y: number) {
    this.parsedPath.scale(1 * x, 1 * y);
    this.scaleX = 1;
    this.scaleY = 1;
    this.afterModelChange();
  }

  translate(x: number, y: number) {
    this.parsedPath.translate(1 * x, 1 * y);
    this.translateX = 0;
    this.translateY = 0;
    this.afterModelChange();
  }

  rotate(x: number, y: number, angle: number) {
    this.parsedPath.rotate(1 * x, 1 * y, 1 * angle);
    this.afterModelChange();
  }

  setRelative(rel: boolean) {
    this.parsedPath.setRelative(rel);
    this.afterModelChange();
  }

  reverse() {
    reversePath(this.parsedPath);
    this.afterModelChange();
  }

  optimize() {
    optimizePath(this.parsedPath, {
      removeUselessCommands: true,
      useHorizontalAndVerticalLines: true,
      useRelativeAbsolute: true,
      useReverse: true,
      useShorthands: true
    });
    this.cfg.minifyOutput=true;
    this.afterModelChange();
  }

  private readonly kAppPathScales: Record<string, number[]> = {
    'M': [1/100, 1/75], 'L': [1/100, 1/75], 'T': [1/100, 1/75],
    'H': [1/100],
    'V': [1/75],
    'C': [1/100, 1/75, 1/100, 1/75, 1/100, 1/75],
    'S': [1/100, 1/75, 1/100, 1/75],
    'Q': [1/100, 1/75, 1/100, 1/75],
    'A': [1/100, 1/75, 1, 1, 1, 1/100, 1/75],
    'Z': [],
  };

  // Known timing function names (matching Swift TimingFunction enum cases).
  readonly timingFunctions = [
    'linear',
    'smoothStep', 'smootherStep',
    'sineEaseIn', 'sineEaseOut', 'sineEaseInOut',
    'quadraticEaseIn', 'quadraticEaseOut', 'quadraticEaseInOut',
    'cubicEaseIn', 'cubicEaseOut', 'cubicEaseInOut',
    'quarticEaseIn', 'quarticEaseOut', 'quarticEaseInOut',
    'quinticEaseIn', 'quinticEaseOut', 'quinticEaseInOut',
    'circularEaseIn', 'circularEaseOut', 'circularEaseInOut',
    'exponentialEaseIn', 'exponentialEaseOut', 'exponentialEaseInOut',
  ];

  setValue(item: SvgItem, idx: number, val: number) {
    if (!isNaN(val)) {
      item.values[idx] = val;
      this.parsedPath.refreshAbsolutePositions();
      this.afterModelChange();
    }
  }

  setDelta(item: SvgItem, idx: number, raw: string) {
    const n = parseFloat(raw);
    item.deltas[idx] = raw === '' || isNaN(n) ? null : Math.abs(n);
    this.afterModelChange();
  }

  setTimingAnnotation(item: SvgItem, val: string) {
    item.timingAnnotation = val || null;
    this.afterModelChange();
  }

  hasAnyDelta(item: SvgItem): boolean {
    return item.deltas.some(d => d !== null);
  }

  insertIntoPath(text: string, textarea: HTMLTextAreaElement) {
    const start = textarea.selectionStart ?? this.rawPath.length;
    const end = textarea.selectionEnd ?? this.rawPath.length;
    const newValue = this.rawPath.substring(0, start) + text + this.rawPath.substring(end);
    this.reloadPath(newValue, newValue.length > 0);
    setTimeout(() => {
      textarea.selectionStart = textarea.selectionEnd = start + text.length;
      textarea.focus();
    }, 0);
  }

  delete(item: SvgItem) {
    this.focusedItem = null;
    this.parsedPath.delete(item);
    this.afterModelChange();
  }

  useAsOrigin(item: SvgItem, subpathOnly?: boolean) {
    const idx = this.parsedPath.path.indexOf(item);
    changePathOrigin(this.parsedPath, idx, subpathOnly);
    this.afterModelChange();
    this.focusedItem = null;
  }

  reverseSubPath(item: SvgItem) {
    const idx = this.parsedPath.path.indexOf(item);
    reversePath(this.parsedPath, idx);
    this.afterModelChange();
    this.focusedItem = null;
  }

  afterModelChange() {
    this.reloadPoints();
    this.rawPath = this.parsedPath.asExtendedString(4, this.cfg.minifyOutput);
    if (this.showingAppPath && !this.isImportingFromApp) {
      this.appPathString = this.generateAppPathString();
    }
  }

  roundValues(decimals: number) {
    this.reloadPath(this.parsedPath.asString(decimals, this.cfg.minifyOutput));
  }

  canDelete(item: SvgItem): boolean {
    const idx = this.parsedPath.path.indexOf(item);
    return idx > 0;
  }
  canInsertAfter(item: SvgItem | null, type: SvgCommandType): boolean {
    let previousType: SvgCommandType | null = null;
    if (item !== null) {
      previousType = item.getType().toUpperCase() as SvgCommandType;
    } else if (this.parsedPath.path.length > 0) {
      previousType = this.parsedPath.path[this.parsedPath.path.length - 1].getType().toUpperCase() as SvgCommandType;
    }
    if (!previousType) {
      return type !== 'Z';
    }
    if (previousType === 'M') {
      return type !== 'M' && type !== 'Z' && type !== 'T' && type !== 'S';
    }
    if (previousType === 'Z') {
      return type !== 'Z' && type !== 'T' && type !== 'S';
    }
    if (previousType === 'C' || previousType === 'S' ) {
      return type !== 'T';
    }
    if (previousType === 'Q' || previousType === 'T' ) {
      return type !== 'S';
    }
    return type !== 'T' && type !== 'S';
  }
  canConvert(item: SvgItem, to: SvgCommandType): boolean {
    const idx = this.parsedPath.path.indexOf(item) ;
    if (idx === 0) {
      return false;
    }
    if (idx > 0) {
      return this.canInsertAfter(this.parsedPath.path[idx - 1], to);
    }
    return false;
  }
  canUseAsOrigin(item: SvgItem): boolean {
    return item.getType().toUpperCase() !== 'Z'
      && this.parsedPath.path.indexOf(item) > 1;
  }

  hasSubPaths(): boolean {
    let moveCount = 0;
    for(const command of this.parsedPath.path) {
      if(command.getType(true) === 'M') {
        moveCount ++;
        if(moveCount == 2) {
          return true;
        }
      }
    }
    return false;
  }

  getTooltip(item: SvgItem, idx: number): string {
    const labels: Record<SvgCommandTypeAny, string[]> = {
      'M': ['x', 'y'],
      'm': ['dx', 'dy'],
      'L': ['x', 'y'],
      'l': ['dx', 'dy'],
      'V': ['y'],
      'v': ['dy'],
      'H': ['x'],
      'h': ['dx'],
      'C': ['x1', 'y1', 'x2', 'y2', 'x', 'y'],
      'c': ['dx1', 'dy1', 'dx2', 'dy2', 'dx', 'dy'],
      'S': ['x2', 'y2', 'x', 'y'],
      's': ['dx2', 'dy2', 'dx', 'dy'],
      'Q': ['x1', 'y1', 'x', 'y'],
      'q': ['dx1', 'dy1', 'dx', 'dy'],
      'T': ['x', 'y'],
      't': ['dx', 'dy'],
      'A': ['rx', 'ry', 'x-axis-rotation', 'large-arc-flag', 'sweep-flag', 'x', 'y'],
      'a': ['rx', 'ry', 'x-axis-rotation', 'large-arc-flag', 'sweep-flag', 'dx', 'dy'],
      'Z': [],
      'z': []
    };
    const commandType = item.getType() as SvgCommandTypeAny;
    return labels[commandType][idx];
  }

  openPath(newPath: string, name: string): void {
    this.pathName = name;
    this.history = [];
    this.historyCursor = -1;
    this.reloadPath(newPath, true);
  }

  reloadPath(newPath: string, autozoom = false): void {
    this.hoveredItem = null;
    this.focusedItem = null;
    this.rawPath = newPath;
    this.invalidSyntax = false;
    try {
      this.parsedPath = new SvgPath(this.rawPath);
      this.reloadPoints();
      if (autozoom) {
        this.zoomAuto();
      }
      if (this.showingAppPath && !this.isImportingFromApp) {
        this.appPathString = this.generateAppPathString();
      }
    } catch (e) {
      this.invalidSyntax = true;
      if (!this.parsedPath) {
        this.parsedPath = new SvgPath('');
      }
    }
  }

  reloadPoints(): void {
    this.targetPoints = this.parsedPath.targetLocations();
    this.controlPoints = this.parsedPath.controlLocations();
  }

  toggleLeftPanel(): void {
    this.isLeftPanelOpened = !this.isLeftPanelOpened;
  }

  toggleAppPath(): void {
    this.showingAppPath = !this.showingAppPath;
    if (this.showingAppPath) {
      this.appPathString = this.generateAppPathString();
    }
  }

  importFromAppString(str: string): void {
    if (!str.trim()) return;
    try {
      const tempPath = new SvgPath(str);
      const scaled = tempPath.path.map(item => {
        const type = item.getType();
        const factors = this.kAppPathScales[type.toUpperCase()] ?? [];
        const parts: string[] = [type];
        for (let i = 0; i < item.values.length; i++) {
          const f = factors[i % factors.length] ?? 1;
          const inv = f !== 0 ? 1 / f : 1;
          const v = Math.round(item.values[i] * inv);
          const d = item.deltas[i] != null ? Math.round(item.deltas[i]! * inv) : null;
          parts.push(d != null ? `${v}\u00b1${d}` : `${v}`);
        }
        if (item.timingAnnotation) parts.push(`@${item.timingAnnotation}`);
        return parts.join(' ');
      }).join(' ');
      this.isImportingFromApp = true;
      try {
        this.reloadPath(scaled, true);
      } finally {
        this.isImportingFromApp = false;
      }
    } catch (e) {
      // Invalid syntax — ignore
    }
  }

  generateAppPathString(): string {
    return this.parsedPath.path.map(item => {
      const type = item.getType();
      const factors = this.kAppPathScales[type.toUpperCase()] ?? [];
      const parts: string[] = [type];
      for (let i = 0; i < item.values.length; i++) {
        const f = factors[i % factors.length] ?? 1;
        const v = +(item.values[i] * f).toFixed(4);
        const d = item.deltas[i] != null ? +(item.deltas[i]! * f).toFixed(4) : null;
        parts.push(d != null ? `${v}\u00b1${d}` : `${v}`);
      }
      if (item.timingAnnotation) parts.push(`@${item.timingAnnotation}`);
      return parts.join(' ');
    }).join(' ');
  }

  deleteImage(image: Image): void {
    this.images.splice(this.images.indexOf(image), 1);
    this.focusedImage = null;
  }

  addImage(newImage: Image): void {
    this.focusedImage = newImage;
    this.images.push(newImage);
  }

  cancelAddImage(): void {
    if(this.images.length === 0) {
      this.isEditingImages = false;
      this.focusedImage = null;
    }
  }

  toggleImageEditing(upload: UploadImageComponent): void {
    this.isEditingImages = !this.isEditingImages;
    this.focusedImage = null;
    this.focusedItem = null;
    if (this.isEditingImages && this.images.length === 0) {
      upload.openDialog();
    }
  }

  focusItem(it: SvgItem | null): void {
    if(it !== this.focusedItem) {
      this.focusedItem = it;
      if(this.focusedItem) {
        const idx = this.parsedPath.path.indexOf(this.focusedItem);
        document.getElementById(`svg_command_row_${idx}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest'
        });
      }
    }
  }
}
