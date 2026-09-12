// Ambient declarations for the classic-script browser boundary.
// The extension pages provide these values at runtime; declaring the boundary here lets the
// checked modules describe their contracts without adding a Chrome npm dependency.
declare const chrome: any;

interface Window {
  [key: string]: any;
}

interface Error {
  [key: string]: any;
}
