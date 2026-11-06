// base './' makes the build work from any folder, including github pages subpaths
export default {
  base: './',
  build: { chunkSizeWarningLimit: 2000 }, // phaser alone is ~1.5 MB unminified, that's expected
};
