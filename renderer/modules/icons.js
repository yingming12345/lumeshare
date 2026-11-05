// 内联 SVG 图标（描边风格，无表情符号）
const S = (paths, viewBox = '0 0 24 24') =>
  '<svg viewBox="' + viewBox + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';

export const icons = {
  library: S('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  share: S('<circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.6 10.7l6.8-3.4M8.6 13.3l6.8 3.4"/>'),
  upload: S('<path d="M12 15V4"/><path d="M7 9l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
  download: S('<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
  chevronL: S('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
  chevronR: S('<path d="M9.5 5.5L16 12l-6.5 6.5"/>'),
  chevronD: S('<path d="M6 9l6 6 6-6"/>'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  min: S('<path d="M6 12h12"/>'),
  max: S('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
  restore: S('<rect x="4" y="9" width="11" height="11" rx="1.5"/><path d="M9 4h9a2 2 0 0 1 2 2v9"/>'),
  copy: S('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  check: S('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  eye: S('<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  folder: S('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'),
  link: S('<path d="M10 14a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 10a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/>'),
  trash: S('<path d="M4 7h16"/><path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2"/><path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/>'),
  zoomIn: S('<circle cx="11" cy="11" r="7"/><path d="M11 8v6M8 11h6"/><path d="M20 20l-3.5-3.5"/>'),
  zoomOut: S('<circle cx="11" cy="11" r="7"/><path d="M8 11h6"/><path d="M20 20l-3.5-3.5"/>'),
  fit: S('<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>'),
  image: S('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17.5l4.5-4.5 3 3 3.5-3.5 5 5"/>'),
  pdf: S('<path d="M7 3.5h7L19 8.5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5V9H19"/><path d="M8.5 14.5h7M8.5 17h4.5"/>'),
  word: S('<path d="M7 3.5h7L19 8.5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5V9H19"/><path d="M9.5 12.5l1.2 4 1.3-4 1.3 4 1.2-4"/>'),
  app: S('<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 9.5h17"/><circle cx="7.2" cy="7.1" r="0.85" fill="currentColor" stroke="none"/><circle cx="10.2" cy="7.1" r="0.85" fill="currentColor" stroke="none"/><path d="M8 13.5h8M8 16.3h5"/>'),
  file: S('<path d="M7 3.5h7L19 8.5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5V9H19"/>'),
  video: S('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.5l5 2.5-5 2.5z"/>'),
  play: S('<path d="M8 5.5v13l10-6.5z"/>'),
  pause: S('<path d="M9 5.5v13M15 5.5v13"/>'),
  volume: S('<path d="M4 10v4h3.5L12 18V6L7.5 10H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>'),
  fullscreen: S('<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>'),
  spinner: '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r="0.6" fill="currentColor" stroke="none"/>'),
};

export function iconFor(kind) {
  switch (kind) {
    case 'image': return icons.image;
    case 'video': return icons.video;
    case 'pdf': return icons.pdf;
    case 'word': return icons.word;
    case 'app': return icons.app;
    default: return icons.file;
  }
}
