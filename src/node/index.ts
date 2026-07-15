import type {
  Runtime,
  RuntimeInstance,
  RuntimeStartRequest,
  TypeDefinitionFile,
} from "../runtime/index.ts";
import {
  createNodeBootstrapSource,
  nodeChannelFileDescriptor,
} from "../node-runtime/bootstrap.ts";
import {
  assertNode24Version,
  loadNode24TypeDefinitionFiles,
} from "../node-runtime/node24.ts";

/** The substrate operations required to run code-mode on Node.js 24. */
export interface Node24RuntimeHost {
  /**
   * Read the version of the same Node.js target used by launchNode(), stopping
   * promptly if the signal aborts.
   */
  readNodeVersion(signal: AbortSignal): Promise<string>;

  /**
   * Evaluate bootstrapSource as an ECMAScript module entrypoint in the target
   * Node.js environment. Connect a full-duplex byte stream at
   * channelFileDescriptor and return its peer as RuntimeInstance.channel.
   *
   * The host owns how source reaches Node.js, the working directory, process
   * lifecycle, launch errors, and termination. It must satisfy the
   * RuntimeInstance lifecycle contract. It observes signal through setup and
   * the returned instance's lifetime: abort before resolution cleans up and
   * rejects with signal.reason; abort afterward terminates promptly.
   */
  launchNode(req: Node24RuntimeLaunchRequest): Promise<RuntimeInstance>;
}

export interface Node24RuntimeLaunchRequest {
  /** Self-contained Node.js ECMAScript module source to launch as the entrypoint. */
  readonly bootstrapSource: string;
  /** The full-duplex descriptor used by the bootstrap's byte channel. */
  readonly channelFileDescriptor: number;
  readonly signal: AbortSignal;
}

/**
 * Adapts the substrate-neutral Runtime contract to a caller-owned Node.js 24
 * execution host. This layer owns Node bootstrap code, target checking, and
 * checker declarations; the supplied host owns execution mechanics.
 */
export class Node24Runtime implements Runtime {
  readonly description = "Node.js 24";
  readonly #host: Node24RuntimeHost;
  #node24Validated = false;

  constructor(host: Node24RuntimeHost) {
    this.#host = host;
  }

  async loadTypeDefinitionFiles(
    signal: AbortSignal,
  ): Promise<readonly TypeDefinitionFile[]> {
    await this.#assertNode24(signal);
    return loadNode24TypeDefinitionFiles(signal);
  }

  async start(req: RuntimeStartRequest): Promise<RuntimeInstance> {
    req.signal.throwIfAborted();
    await this.#assertNode24(req.signal);
    req.signal.throwIfAborted();

    return this.#host.launchNode({
      bootstrapSource: createNodeBootstrapSource(req.payload),
      channelFileDescriptor: nodeChannelFileDescriptor,
      signal: req.signal,
    });
  }

  async #assertNode24(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#node24Validated) {
      return;
    }

    const version = await this.#host.readNodeVersion(signal);
    signal.throwIfAborted();
    assertNode24Version(version, "Node runtime target");
    this.#node24Validated = true;
  }
}
