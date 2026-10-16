/**
 * Phase 13: get one image from the camera or the gallery for "What is this?" questions.
 *
 * - Gallery uses Android's system Photo Picker (react-native-image-picker → PickVisualMedia): no storage permission.
 * - Camera uses the system camera app (ACTION_IMAGE_CAPTURE): this app never declares or needs CAMERA permission,
 *   so there is no permission prompt; the camera app itself is the only thing that touches the hardware.
 * - Photos are resized on the phone (max 1280 px, JPEG quality 0.8) before upload.
 * - The image lives only in memory as base64; the library's temporary cache file is deleted right after reading.
 */
import * as RNFS from '@dr.pogodin/react-native-fs';
import { launchCamera, launchImageLibrary, type CameraOptions, type ImagePickerResponse } from 'react-native-image-picker';

export type Attachment = { mime: string; data: string; bytes: number; width?: number; height?: number; preview: string };
export type PickResult = { attachment?: Attachment; cancelled?: boolean; error?: string };

export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // same limit as backend/app/vision.py
const OPTIONS: CameraOptions = {
  mediaType: 'photo', maxWidth: 1280, maxHeight: 1280, quality: 0.8, includeBase64: true, saveToPhotos: false,
};

/** Turn a picker response into an attachment, a cancellation, or a user-readable error. */
export function fromResponse(r: ImagePickerResponse): PickResult {
  if (r.didCancel) return { cancelled: true };
  if (r.errorCode === 'camera_unavailable') return { error: 'No camera is available on this device.' };
  if (r.errorCode === 'permission') return { error: 'Permission was denied, so no image was taken. You can allow it in Android Settings.' };
  if (r.errorCode) return { error: `Couldn't get the image (${r.errorMessage || r.errorCode}).` };
  const a = r.assets?.[0];
  if (!a?.base64) return { error: 'No image data was received.' };
  const mime = (a.type || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!ALLOWED_MIME.includes(mime)) return { error: `Unsupported image type (${a.type || 'unknown'}). Use JPEG, PNG or WebP.` };
  const bytes = Math.floor((a.base64.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) return { error: `Image is too large (${(bytes / 1048576).toFixed(1)} MB, max 5 MB).` };
  return {
    attachment: {
      mime, data: a.base64, bytes, width: a.width, height: a.height, preview: `data:${mime};base64,${a.base64}`,
    },
  };
}

/** Delete the temporary files the picker wrote into this app's cache (never touches the user's gallery). */
export async function cleanup(r: ImagePickerResponse): Promise<void> {
  for (const a of r.assets ?? []) {
    const path = (a.uri || '').replace(/^file:\/\//, '');
    if (path && path.startsWith(RNFS.CachesDirectoryPath)) await RNFS.unlink(path).catch(() => undefined);
  }
}

/** Open the camera or the photo picker and return the chosen image (or why there isn't one). */
export async function pickImage(source: 'camera' | 'gallery'): Promise<PickResult> {
  const r = source === 'camera' ? await launchCamera(OPTIONS) : await launchImageLibrary({ ...OPTIONS, selectionLimit: 1 });
  try {
    return fromResponse(r);
  } finally {
    await cleanup(r);
  }
}
