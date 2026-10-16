/**
 * Device state for the model download, from Android (android/.../AiDeviceModule.kt): network state, and keeping the
 * screen on while downloading. Chat never needs the network; only the model download does.
 */
import { NativeModules } from 'react-native';

/** 'unknown': the native module is missing or failed; the download is then attempted and its own errors handled. */
export type Connectivity = 'online' | 'no_internet' | 'offline' | 'unknown';

/** The current network state; never throws. */
export async function connectivity(): Promise<Connectivity> {
  try {
    return (await NativeModules.AiDevice?.connectivity()) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Keep the screen on while this app is in front (true) or allow it to turn off again (false). During the model
 * download the screen must stay on: on the Galaxy M35 with battery saver on, screen-off cut the app's network.
 */
export function keepScreenOn(on: boolean): void {
  NativeModules.AiDevice?.keepScreenOn?.(on);
}
