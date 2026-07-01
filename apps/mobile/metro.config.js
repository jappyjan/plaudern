// Metro config for the Expo app inside the Nx monorepo (plan §1/§7).
// Two wrappers are layered:
//   - withNxMetro: lets Metro resolve workspace libs (@plaudern/*) and watch the repo
//   - withUniwind: compiles Tailwind v4 (via Uniwind) — HeroUI Native's styling engine
const { getDefaultConfig } = require('expo/metro-config');
const { withNxMetro } = require('@nx/expo');
const { withUniwind } = require('uniwind/metro');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

module.exports = withUniwind(
  withNxMetro(config, {
    debug: false,
    extensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
    watchFolders: [],
  }),
  { input: './global.css' },
);
