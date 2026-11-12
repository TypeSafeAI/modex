import "./workspace";

// The desktop renderer reads `window.modex` once, when its bridge module loads, and a bundler
// may evaluate a shared chunk before this entry's own body. Loading the interface only after
// the workspace is installed keeps that order fixed.
void import("./shell");
