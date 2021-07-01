import {
  Ens_Query,
  Ipfs_Query,
  ApiResolver_Query,
  ApiResolver_MaybeUriOrManifest,
  Input_tryResolveUri,
  Input_getFile
} from "./w3";

const impls: ApiResolver_Query[] = [
  Ens_Query,
  Ipfs_Query
];

export function tryResolveUri(
  input: Input_tryResolveUri
): ApiResolver_MaybeUriOrManifest {

  // Iterate through all implementations
  for (const impl of impls) {
    // See if they support the URI
    const result = impl.tryResolveUri({
      authority: input.authority,
      path: input.path
    });

    // If the result yields something, return
    if (result.newUri || result.packageManifest) {
      return {
        newUri: result.newUri,
        packageManifest: result.packageManifest,
        newResolverUri: impl.uri
      };
    }
  }
}

export function getFile(
  input: Input_getFile
): ArrayBuffer {
  throw Error(
    "This should never be called. Use the 'newResolverUri' returned from tryResolveUri to get a file."
  );
}
