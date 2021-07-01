# API-Resolver Aggregator
## Context
The "api-resolver" interface is currently being used whenever we resolve a Web3API's URI. It's made in a way to support any "URI authority" (ex: ENS, IPFS, HTTP, etc). The interface schema is as follows:
```graphql
type Query {
  tryResolveUri(
    authority: String!
    path: String!
  ): MaybeUriOrManifest

  getFile(
    path: String!
  ): Bytes
}

type MaybeUriOrManifest {
  uri: String
  manifest: String
}
```

This schema is then implemented by various Web3APIs. Currently the only 2 implementations that exist are ENS and IPFS. To understand better what this looks like, here's an example of IPFS' implementation:
```typescript
export const query = (ipfs: IpfsPlugin): PluginModule => ({

  tryResolveUri: async (
    input: { authority: string; path: string }
  ) => {
    if (input.authority !== "ipfs") {
      return null;
    }

    if (IpfsPlugin.isCID(input.path)) {
      // Try fetching uri/web3api.yaml
      try {
        return {
          manifest: await ipfs.catToString(`${input.path}/web3api.yaml`, {
            timeout: 5000,
          }),
          uri: null,
        };
      } catch (e) { }

      // Try fetching uri/web3api.yml
      try {
        return {
          manifest: await ipfs.catToString(`${input.path}/web3api.yml`, {
            timeout: 5000,
          }),
          uri: null,
        };
      } catch (e) { }
    }

    // Nothing found
    return { manifest: null, uri: null };
  },

  getFile: async (input: { path: string }) => {
    try {
      const { cid, provider } = await ipfs.resolve(input.path, {
        timeout: 5000,
      });

      return await ipfs.cat(cid, {
        provider: provider,
      });
    } catch (e) {
      return null;
    }
  },
});
```

Now that we understand what the api-resolver interface + implementations look like, we can start to look at how the toolchain uses them. It's pretty straight forward, whenever [the "resolve-uri" core algorithm](TODO) is called, it gets all api-resolver implementations it knows about:
```typescript
const uriResolverImplementations = getImplementations(
  new Uri("w3://ens/api-resolver.core.web3api.eth"),
  redirects
);
```

It will then iterate through them, and ask each one to try and resolve the provided URI (`w3://ipfs/QmHASH` for example):
```typescript
// Iterate through all api-resolver implementations,
// iteratively resolving the URI until we reach the Web3API manifest
for (let i = 0; i < uriResolverImplementations.length; ++i) {
  const uriResolver = uriResolverImplementations[i];

  const { data } = await ApiResolver.Query.tryResolveUri(
    client,
    uriResolver,
    resolvedUri
  );

  // If nothing was returned, the URI is not supported
  if (!data || (!data.uri && !data.manifest)) {
    continue;
  }

  const newUri = data.uri;
  const manifestStr = data.manifest;

  if (newUri) {
    // Use the new URI, and reset our index
    const convertedUri = new Uri(newUri);
    resolvedUri = convertedUri;

    // Restart the iteration over again
    i = -1;
    continue;
  } else if (manifestStr) {
    // We've found our manifest at the current URI resolver
    // meaning the URI resolver can also be used as an API resolver
    const manifest = deserializeManifest(manifestStr, { noValidate });
    return createApi(uri, manifest, apiResolver)
  }
}
```

## The Problem

In order to add new types of api-resolver implementations, we must update the client like so:
```typescript
new Web3ApiClient({
  interfaces: [
    {
      interface: "w3://ens/api-resolver.core.web3api.eth",
      implementations: [
        "w3://ens/new-api-resolver.eth",
        "w3://ens/ens.web3api.eth",
        "w3://ens/ipfs.web3api.eth"
      ]
    }
  ]
})
``` 

This isn't very extendable, and burdens the app developer with something they shouldn't really have to worry about.

## The Solution

I propose we create an api-resolver aggregator Web3API. This way all the client has to do is query into the aggregator, and the rest will be taken care of. Updates can be made without requiring any client changes. Simply:
- Modify the aggregator
- Rebuild & publish to IPFS
- Update the content ID on ENS

And boom, all clients using the api-resolver aggregator will gain new functionality, without having to be rebuilt themselves.

## The Implementation
### Interface Schema

In order to build this, we must make an addition to the api-resolver interface. Here's the new interface, with comments above the new additions:
```graphql
type Query {
  tryResolveUri(
    authority: String!
    path: String!
  ): MaybeUriOrManifest

  getFile(
    path: String!
  ): Bytes
}

# This whole structure has been updated
type MaybeUriOrManifest {
  # newUri: The new URI of the API being queried. For example,
  # an ENS URI may become an IPFS URI.
  newUri: String

  # packageManifest: The web3api.yaml manifest file's contents.
  # If this is present, we've reached our API's location!
  packageManifest: String

  # newResolverUri: A new URI, telling the client "this is the
  # new api-resolver implementation you should be calling into"
  newResolverUri: String
}
```

### Aggregator Schema
The aggregator's schema is as follows:
```graphql
#import { Query, MaybeUriOrManifest } into ApiResolver from "w3://ens/api-resolver.core.web3api.eth"
#import { Query } into Ens from "w3://ens/ens.web3api.eth"
#import { Query } into Ipfs from "w3://ens/ipfs.web3api.eth"

type Query implements ApiResolver_Query {
  tryResolveUri(
    authority: String!
    path: String!
  ): ApiResolver_MaybeUriOrManifest

  getFile(
    path: String!
  ): Bytes
}
```

### Aggregator Wasm
And lastly, this is the aggregator's Assemblyscript implementation:
```typescript
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
```

### Finally

And finally, we'd just need to make some minor updates to the resolve-uri algorithm, where the `newResolverUri` is being used appropriately.

## Final Thoughts

This is extremely exciting to me, because it means we can "roll out" support for new api-resolvers, without requiring application developers to do anything on their end. Can't wait to build this for real for real :D
