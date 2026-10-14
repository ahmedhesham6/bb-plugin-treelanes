import manifest from "./package.json" with { type: "json" };

/** bb derives the plugin ID from the package name. */
export const PLUGIN_ID = manifest.name.replace(/^bb-plugin-/, "");
