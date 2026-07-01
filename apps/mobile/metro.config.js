// Metro config for the Expo app inside the Nx monorepo (plan §1/§7).
// Expo's default config auto-detects the pnpm workspace (watchFolders +
// nodeModulesPaths cover the @plaudern/* libs); withUniwind compiles
// Tailwind v4 (via Uniwind) — HeroUI Native's styling engine.
// ponytail: dropped withNxMetro — @nx/expo was never installed and Expo's
// monorepo detection already does its job; re-add if lib resolution breaks.
const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withUniwindConfig(config, { cssEntryFile: './global.css' });
