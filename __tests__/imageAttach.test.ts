/**
 * Phase 13: camera/gallery attachment rules with unit-test mocks of the native picker and file system
 * (no device in Jest; the real camera and Photo Picker are tested on the Galaxy M35).
 */
jest.mock('react-native-image-picker', () => ({ launchCamera: jest.fn(), launchImageLibrary: jest.fn() }));
jest.mock('@dr.pogodin/react-native-fs', () => ({ CachesDirectoryPath: '/data/cache', unlink: jest.fn().mockResolvedValue(undefined) }));

import * as RNFS from '@dr.pogodin/react-native-fs';
import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import { fromResponse, pickImage, MAX_IMAGE_BYTES } from '../src/imageAttach';

const jpeg = { uri: 'file:///data/cache/rn_image_picker_lib_temp_1.jpg', type: 'image/jpeg', base64: 'AAAA', width: 1280, height: 960 };

test('valid photo becomes an in-memory attachment with a preview', () => {
  const r = fromResponse({ assets: [jpeg] });
  expect(r.attachment).toEqual({ mime: 'image/jpeg', data: 'AAAA', bytes: 3, width: 1280, height: 960, preview: 'data:image/jpeg;base64,AAAA' });
});

test('cancel, permission denied, no camera, unsupported type, oversized, empty', () => {
  expect(fromResponse({ didCancel: true })).toEqual({ cancelled: true });
  expect(fromResponse({ errorCode: 'permission' }).error).toContain('Permission was denied');
  expect(fromResponse({ errorCode: 'camera_unavailable' }).error).toContain('No camera');
  expect(fromResponse({ assets: [{ ...jpeg, type: 'image/gif' }] }).error).toContain('Unsupported image type (image/gif)');
  expect(fromResponse({ assets: [{ ...jpeg, type: 'image/heic' }] }).error).toContain('Use JPEG, PNG or WebP');
  const big = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8);
  expect(fromResponse({ assets: [{ ...jpeg, base64: big }] }).error).toContain('too large');
  expect(fromResponse({ assets: [{ ...jpeg, base64: undefined }] }).error).toContain('No image data');
});

test('camera and gallery use resize options; temp cache file is deleted after reading', async () => {
  (launchCamera as jest.Mock).mockResolvedValue({ assets: [jpeg] });
  (launchImageLibrary as jest.Mock).mockResolvedValue({ assets: [{ ...jpeg, uri: 'content://media/picker/1' }] });
  expect((await pickImage('camera')).attachment?.mime).toBe('image/jpeg');
  expect((launchCamera as jest.Mock).mock.calls[0][0]).toMatchObject({ maxWidth: 1280, maxHeight: 1280, quality: 0.8, includeBase64: true, saveToPhotos: false });
  expect(RNFS.unlink).toHaveBeenCalledWith('/data/cache/rn_image_picker_lib_temp_1.jpg');
  (RNFS.unlink as jest.Mock).mockClear();
  await pickImage('gallery');
  expect((launchImageLibrary as jest.Mock).mock.calls[0][0]).toMatchObject({ selectionLimit: 1, mediaType: 'photo' });
  expect(RNFS.unlink).not.toHaveBeenCalled(); // never deletes anything outside this app's cache (the user's photos)
});
