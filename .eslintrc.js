module.exports = {
  root: true,
  extends: '@react-native',
  // Generated output (Gradle reports, bundles) is not source code.
  ignorePatterns: ['android/**/build/**', 'android/sdjni/third_party/**', 'coverage/**', 'verification/runs/**'],
};
