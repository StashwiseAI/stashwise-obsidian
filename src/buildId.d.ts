// Injected by esbuild at build time. See esbuild.config.mjs.
declare const STASHWISE_BUILD_ID: string;

// True only in dev builds. esbuild substitutes a literal, so `if (STASHWISE_DEV)`
// is dead-code eliminated from the released bundle.
declare const STASHWISE_DEV: boolean;
