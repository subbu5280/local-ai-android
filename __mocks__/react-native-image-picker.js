// Jest: the image picker is native (camera / photo picker). Suites that test photos override these with their own results.
module.exports = { launchCamera: jest.fn(async () => ({ didCancel: true })), launchImageLibrary: jest.fn(async () => ({ didCancel: true })) };
