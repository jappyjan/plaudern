// SDK 56 moved the classic upload API (uploadAsync / FileSystemUploadType) to
// the `/legacy` entry; the new File API doesn't cover presigned binary PUT yet.
import * as FileSystem from 'expo-file-system/legacy';
import type { UploadFn } from '@plaudern/mobile-api-client';

/**
 * Uploads a local file to a presigned S3/MinIO PUT URL using expo-file-system
 * (background-capable, avoids buffering the whole file in JS). This is the
 * `UploadFn` the API client calls; it's independent of where the file came
 * from — Plaud export or the dev document picker (plan §3/§4).
 */
export const uploadFile: UploadFn = async ({ uploadUrl, fileUri, contentType }) => {
  const res = await FileSystem.uploadAsync(uploadUrl, fileUri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'content-type': contentType },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`upload failed with status ${res.status}`);
  }
};
