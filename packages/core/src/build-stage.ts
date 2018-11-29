import WaitForTrees, { OutputPaths } from "./wait-for-trees";
import PackageCache from "./package-cache";
import Stage from "./stage";
import { Tree } from "broccoli-plugin";
import { Memoize } from "typescript-memoize";

// This is a utility class for defining new Stages. It aids in handling the
// boilerplate required to split your functionality between the
// broccoli-pipeline-construction base and the actual building phase.
export default class BuildStage<NamedTrees> implements Stage {
  private active: BuilderInstance<NamedTrees> | undefined;
  private outputPath: string | undefined;
  private packageCache: PackageCache | undefined;

  constructor(
    private prevStage: Stage,
    private inTrees: NamedTrees,
    private instantiate: (root: string, appSrcDir: string, packageCache: PackageCache) => Promise<BuilderInstance<NamedTrees>>
  ) {}

  get tree(): Tree {
    return new WaitForTrees(this.inTrees, async (treePaths) => {
      if (!this.active) {
        let { outputPath, packageCache } = await this.prevStage.ready();
        if (!packageCache) {
          packageCache = new PackageCache();
        }
        this.outputPath = outputPath;
        this.packageCache = packageCache;
        this.active = await this.instantiate(outputPath, this.prevStage.inputPath, packageCache);
      }
      await this.active.build(treePaths);
      this.deferReady.resolve();
    });
  }

  get inputPath(): string {
    return this.prevStage.inputPath;
  }

  async ready(): Promise<{ outputPath: string, packageCache: PackageCache }>{
    await this.deferReady.promise;
    return {
      outputPath: this.outputPath!,
      packageCache: this.packageCache!
    };
  }

  @Memoize()
  private get deferReady() {
    let resolve: Function;
    let promise: Promise<void> = new Promise(r => resolve =r);
    return { resolve: resolve!, promise };
  }
}

interface BuilderInstance<NamedTrees> {
  build(inputPaths: OutputPaths<NamedTrees>): Promise<void>;
}
