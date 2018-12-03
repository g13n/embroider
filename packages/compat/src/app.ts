import { Tree } from 'broccoli-plugin';
import mergeTrees from 'broccoli-merge-trees';
import {
  Package,
  Stage,
  AppMeta,
  PackageCache,
  OutputPaths,
  BuildStage
} from '@embroider/core';
import sortBy from 'lodash/sortBy';
import resolve from 'resolve';
import { TrackedImports } from './tracked-imports';
import { Memoize } from "typescript-memoize";
import V1InstanceCache from './v1-instance-cache';
import V1App from './v1-app';
import walkSync from 'walk-sync';
import { writeFileSync, ensureDirSync, readFileSync, copySync, readdirSync, removeSync } from 'fs-extra';
import { join, dirname, relative } from 'path';
import { compile } from './js-handlebars';
import { todo, unsupported } from './messages';
import cloneDeep from 'lodash/cloneDeep';
import { JSDOM } from 'jsdom';
import DependencyAnalyzer from './dependency-analyzer';
import { V1Config, ConfigContents, EmberENV } from './v1-config';
import { assertTSNeverKeyword } from 'babel-types';

interface BaseAsset {
  // where this asset should be placed, relative to the app's root
  relativePath: string;
}

export interface OnDiskAsset extends BaseAsset {
  kind: "on-disk";

  // absolute path to where we will find it
  sourcePath: string;
}

export interface InMemoryAsset extends BaseAsset {
  kind: "in-memory";

  // the actual bits
  source: string | Buffer;
}

export interface DOMAsset extends BaseAsset {
  kind: "dom";

  // an already-parsed document
  dom: JSDOM;

  // declares that the ember app should be inserted into this asset
  insertEmberApp?: AppInsertion;
}

export interface AppInsertion {
  // each of the Nodes in here points at where we should insert the
  // corresponding parts of the ember app. The Nodes themselves will be
  // replaced, so provide placeholders.

  // these are mandatory, the Ember app may need to put things into them.
  javascript: Node;
  styles: Node;
  implicitScripts: Node;
  implicitStyles: Node;

  // these are optional because you *may* choose to stick your implicit test
  // things into specific locations (which we need for backward-compat). But you
  // can leave these off and we will simply put them in the same places as the
  // non-test things.
  //
  // DO NOT CONFUSE these with controlling whether or not we will insert tests.
  // That is a separate question that doesn't belong here.
  testJavascript?: Node;
  implicitTestScripts?: Node;
  implicitTestStyles?: Node;
}

export function appInsertion(ai: Partial<AppInsertion>): AppInsertion {
  if (!ai.javascript || !ai.styles || !ai.implicitScripts || !ai.implicitStyles) {
    throw new Error(`bug: expected a complete AppInsertion`);
  }
  return ai as AppInsertion;
}

export type Asset = OnDiskAsset | InMemoryAsset | DOMAsset;

// todo: instead of abstract base class, perhaps an adapter pattern so we have
// clearer separation.
export default abstract class App<TreeNames> {
  protected abstract config(): ConfigContents;
  protected abstract externals(): string[];
  protected abstract templateCompilerSource(config: EmberENV): string;
  protected abstract babelConfig(): { config: BabelConfig, syntheticPlugins: Map<string, string> };
  protected abstract assets(treePaths: OutputPaths<TreeNames>): Asset[];

  // TODO: refactor away
  protected abstract copyAppJS(treePaths: OutputPaths<TreeNames>, dest: string): void;

  constructor(protected root: string, protected app: Package) {
  }

  @Memoize()
  protected get activeAddonDescendants(): Package[] {
    // todo: filter by addon-provided hook
    return this.app.findDescendants(dep => dep.isEmberPackage);
  }

  private clearApp() {
    for (let name of readdirSync(this.root)) {
      if (name !== 'node_modules') {
        removeSync(join(this.root, name));
      }
    }
  }

  private addTemplateCompiler(config: EmberENV) {
    writeFileSync(
      join(this.root, "_template_compiler_.js"),
      this.templateCompilerSource(config),
      "utf8"
    );
  }

  // this is stuff that needs to get set globally before Ember loads. In classic
  // Ember CLI is was "vendor-prefix" content that would go at the start of the
  // vendor.js. We are going to make sure it's the first plain <script> in the
  // HTML that we hand to the final stage packager.
  private addEmberEnv(config: EmberENV) {
    writeFileSync(
      join(this.root, "_ember_env_.js"),
      `window.EmberENV=${JSON.stringify(config, null, 2)};`,
      "utf8"
    );
  }

  private addBabelConfig() {
    let { config, syntheticPlugins } = this.babelConfig();

    for (let [name, source] of syntheticPlugins) {
      let fullName = join(this.root, name);
      writeFileSync(fullName, source, 'utf8');
      let index = config.plugins.indexOf(name);
      config.plugins[index] = fullName;
    }

    writeFileSync(
      join(this.root, "_babel_config_.js"),
      `
    module.exports = ${JSON.stringify(config, null, 2)};
    `,
      "utf8"
    );
  }

  private rewriteHTML(htmlTreePath: string) {
    for (let entrypoint of this.emberEntrypoints()) {
      let dom = new JSDOM(readFileSync(join(htmlTreePath, entrypoint), "utf8"));
      this.updateHTML(entrypoint, dom);
      let outputFile = join(this.root, entrypoint);
      ensureDirSync(dirname(outputFile));
      writeFileSync(outputFile, dom.serialize(), "utf8");
    }
  }

  private emitDOMAsset(config: ConfigContents, asset: DOMAsset) {
    
  }

  async build(inputPaths: OutputPaths<TreeNames>) {
    // the steps in here are order dependent!
    let config = this.config();

    // start with a clean app directory, leaving only our node_modules
    this.clearApp();

    // first thing we add: we're copying only "app-js"
    // stuff, first from addons, and then from the app itself (so it can
    // ovewrite the files from addons).
    for (let addon of this.activeAddonDescendants) {
      let appJSPath = addon.meta["app-js"];
      if (appJSPath) {
        copySync(join(addon.root, appJSPath), this.root);
      }
    }

    this.copyAppJS(inputPaths, this.root);

    let assets = this.assets(inputPaths);
    for (let asset of assets) {
      if (asset.kind === 'dom') {
        this.emitDOMAsset(config, asset);
      }
    }

    for (let asset of assets) {
      let destination = join(this.root, asset.relativePath);
      switch(asset.kind) {
        case 'dom':
          // already handled above, first. TODO: refactor this order dependence
          // away when we do better incremental builds
          break;
        case 'on-disk':
          ensureDirSync(dirname(destination));
          copySync(asset.sourcePath, destination);
          break;
        case 'in-memory':
          ensureDirSync(dirname(destination));
          writeFileSync(destination, asset.source);
          break;
        default:
          assertNever(asset);
      }
    }

    this.addTemplateCompiler(config.EmberENV);
    this.addBabelConfig();
    this.addEmberEnv(config.EmberENV);

    let meta: AppMeta = {
      version: 2,
      externals: this.externals(),
      entrypoints: this.emberEntrypoints().concat(entrypoints),
      ["template-compiler"]: "_template_compiler_.js",
      ["babel-config"]: "_babel_config_.js",
    };

    let pkg = cloneDeep(this.app.packageJSON);
    pkg["ember-addon"] = Object.assign({}, pkg["ember-addon"], meta);
    writeFileSync(
      join(this.root, "package.json"),
      JSON.stringify(pkg, null, 2),
      "utf8"
    );
    this.rewriteHTML(inputPaths.htmlTree);
  }
}

function assertNever(_: never) {
  throw "should never get here";
}
