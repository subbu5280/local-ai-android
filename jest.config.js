module.exports = {
  preset: '@react-native/jest-preset',
  // M9: the app-level UI tests wait on real timers between steps; under load (Gradle + an emulator running) they took
  // 2-3x longer and hit Jest's 5 s default. A larger budget changes no assertion.
  testTimeout: 30_000,
};
