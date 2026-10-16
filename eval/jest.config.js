// Developer evaluation runs (npm run eval): same Jest setup as the tests, but only eval/*.eval.ts files.
// They write reports to eval/results/ and never fail on scores (scores are measurements, not pass/fail tests).
module.exports = {
  preset: '@react-native/jest-preset',
  rootDir: '..',
  testMatch: ['<rootDir>/eval/**/*.eval.ts'],
};
