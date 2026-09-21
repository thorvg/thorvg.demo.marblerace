// WASM modules are loaded as URLs, checkout next.config.mjs
declare module '*.wasm' {
  const url: string;
  export default url;
}
