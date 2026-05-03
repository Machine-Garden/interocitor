import { createElement } from 'react';
import type { Interocitor } from '@interocitor/core';
import { useImage } from './image.ts';
import type { UseImageResult } from './image.ts';

type TestDb = {
  profiles: {
    avatarPath?: string;
  };
};

export function UseImageTypeFixture({ db, path }: { db: Interocitor<TestDb>; path?: string }): ReturnType<typeof createElement> | null {
  const image: UseImageResult = useImage(db, path);

  if (image.loading || image.error || !image.url) return null;

  image.revoke();
  const blob: Blob = image.blob!;
  const contentType: string = image.contentType!;
  const uploadedBy = image.metadata?.uploadedByDeviceId;

  return createElement('img', {
    src: image.url,
    alt: uploadedBy ?? contentType ?? blob.type,
  });
}
