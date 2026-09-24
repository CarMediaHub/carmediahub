import type { BrowserTask, ScopeContext } from "@carmediahub/sdk";
import type { ComponentCatalogItem } from "./components.js";
import type { Repository } from "./repository.js";
import type { BrowserWorkerOptionsResolver } from "./browser-task-handlers.js";
import type { BrowserTargetRegistry } from "./browser-target-registry.js";
import { currentPlatformKey } from "./components.js";

export interface ManagedBrowserWorkerResolverOptions {
  dataDir: string;
  catalog: readonly ComponentCatalogItem[];
  repository: Repository;
  targetRegistry: BrowserTargetRegistry;
}

/** Resolves only a healthy, Core-registered browser-engine component. */
export function createManagedBrowserWorkerOptionsResolver(options: ManagedBrowserWorkerResolverOptions): BrowserWorkerOptionsResolver {
  return async (scope: ScopeContext, task: BrowserTask) => {
    if (!options.repository.pluginHasCapability(scope.installationId, "browser")) throw new Error("Plugin browser capability is not granted");
    const targetId = task.input.target;
    if (targetId === undefined || options.targetRegistry.get(targetId) === undefined) throw new Error("Browser target is not registered");
    const platform = currentPlatformKey();
    const browserCatalog = options.catalog.filter((item) => item.provides.includes("browser-engine") && item.platforms.includes(platform)).sort((left, right) => left.id.localeCompare(right.id));
    const component = browserCatalog.map((item) => options.repository.componentById(item.id)).find((item) => item !== undefined && item.health === "healthy" && item.verified);
    if (component === undefined) throw new Error("A healthy browser-engine component is not installed");
    return {
      dataDir: options.dataDir,
      component,
      catalog: options.catalog,
      scope: { organizationId: scope.organizationId, userId: scope.userId, installationId: scope.installationId, sessionId: task.sessionId },
      targetRegistry: options.targetRegistry,
      targetId
    };
  };
}
