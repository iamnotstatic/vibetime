declare module '*.woff2' {
  const bytes: ArrayBuffer;
  export default bytes;
}

declare module '*.png' {
  const bytes: ArrayBuffer;
  export default bytes;
}

declare module '*.ttf' {
  const bytes: ArrayBuffer;
  export default bytes;
}

declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
