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
import AppDiffer from '@embroider/core/src/app-differ';

export type ImplicitSection = "implicit-scripts" | "implicit-styles" | "implicit-test-scripts" | "implicit-test-styles" | "implicit-modules" | "implicit-test-modules";

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

export type Asset = OnDiskAsset | InMemoryAsset | DOMAsset;

export interface AppInsertion {
  // whether to inside the test suite in addition to the ember app
  includeTests: true;

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
  // That is separately controlled via `includeTests`.
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

export interface AppAdapter<TreeNames> {
  config(): ConfigContents;
  externals(): string[];
  templateCompilerSource(config: EmberENV): string;
  babelConfig(): { config: { plugins: (string | [])[]}, syntheticPlugins: Map<string, string> };
  assets(treePaths: OutputPaths<TreeNames>): Asset[];
  ownJSPath(): string;
  mainModule(): string;
  autoRun(): boolean;
  ownImpliedDeps(section: ImplicitSection): string[];
  scriptPriority(pkg: Package): number;
}

export default class App<TreeNames> {
  constructor(private root: string, private app: Package, private adapter: AppAdapter<TreeNames>) {
  }

  @Memoize()
  private get activeAddonDescendants(): Package[] {
    // todo: filter by addon-provided hook
    return this.app.findDescendants(dep => dep.isEmberPackage);
  }

  private addTemplateCompiler(config: EmberENV) {
    writeFileSync(
      join(this.root, "_template_compiler_.js"),
      this.adapter.templateCompilerSource(config),
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
    let { config, syntheticPlugins } = this.adapter.babelConfig();

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

  private gatherImpliedDeps(section: ImplicitSection) {
    let result = [];
    // FIXME: cache the sorting
    for (let addon of sortBy(
      this.activeAddonDescendants,
      this.adapter.scriptPriority.bind(this)
    )) {
      let implicitScripts = addon.meta[section];
      if (implicitScripts) {
        for (let mod of implicitScripts) {
          result.push(resolve.sync(mod, { basedir: addon.root }));
        }
      }
    }
    return result;
  }

  // fixme: eliminate in favor of gatherImpliedDeps
  private gatherImplicitModules(section: "implicit-modules" | "implicit-test-modules", lazyModules: { runtime: string, buildtime: string }[]) {
    for (let addon of this.activeAddonDescendants) {
      let implicitModules = addon.meta[section];
      if (implicitModules) {
        for (let name of implicitModules) {
          lazyModules.push({
            runtime: join(addon.name, name),
            buildtime: relative(
              join(this.root, "assets"),
              `${addon.root}/${name}`
            ),
          });
        }
      }
    }
  }

  // FIXME: derive the name automatically and coalesce if multiple entrypoints end up with the same javascript
  private javascriptEntrypoint(name: string, config: ConfigContents, appFiles: Set<string>): Asset {
    let mainModule = join(
      this.root,
      this.adapter.mainModule()
    );

    // for the app tree, we take everything
    let lazyModules = [...appFiles].map(relativePath => {
      if (!relativePath.startsWith('tests/') && (relativePath.endsWith('.js') || relativePath.endsWith('.hbs'))) {
        let noJS = relativePath.replace(/\.js$/, "");
        let noHBS = noJS.replace(/\.hbs$/, "");
        return {
          runtime: `${config.modulePrefix}/${noHBS}`,
          buildtime: `../${noJS}`,
        };
      }
    }).filter(Boolean) as { runtime: string, buildtime: string }[];

    // for the src tree, we can limit ourselves to only known resolvable
    // collections
    todo("app src tree");

    // this is a backward-compatibility feature: addons can force inclusion of
    // modules.
    this.gatherImplicitModules('implicit-modules', lazyModules);

    let source = entryTemplate({
      lazyModules,
      autoRun: this.adapter.autoRun(),
      mainModule: relative(join(this.root, 'assets'), mainModule),
      appConfig: config.APP,
    });

    return{
      kind: 'in-memory',
      relativePath: `assets/${name}.js`,
      source
    };
  }

  // FIXME: unify with javascriptEntrypoint
  private testEntrypoint(appFiles: Set<string>): Asset {
    let testModules = [...appFiles].map(relativePath => {
      if (relativePath.startsWith("tests/") && relativePath.endsWith('-test.js')) {
        return `../${relativePath}`;
      }
    }).filter(Boolean) as string[];

    let lazyModules: { runtime: string, buildtime: string }[] = [];
    // this is a backward-compatibility feature: addons can force inclusion of
    // test support modules.
    this.gatherImplicitModules('implicit-test-modules', lazyModules);

    return {
      kind: 'in-memory',
      relativePath: 'assets/test.js',
      source: testTemplate({
        testModules,
        lazyModules
      })
    };
  }

  private addScriptTag(docAsset: DOMAsset, scriptAsset: Asset, target: Node) {
    let scriptTag = docAsset.dom.window.document.createElement('script');
    scriptTag.type = 'module';
    scriptTag.src = relative(dirname(docAsset.relativePath), scriptAsset.relativePath);
    target.parentElement!.insertBefore(scriptTag, target);
  }

  private emitDOMAsset(config: ConfigContents, appFiles: Set<string>, asset: DOMAsset): Asset[] {
    let additionalAssets: Asset[] = [];

    if (asset.insertEmberApp) {
      let js = this.javascriptEntrypoint('app.js', config, appFiles);
      additionalAssets.push(js);
      this.addScriptTag(asset, js, asset.insertEmberApp.javascript);

      if (asset.insertEmberApp.includeTests) {
        let js = this.testEntrypoint(appFiles);
        additionalAssets.push(js);
        this.addScriptTag(asset, js, asset.insertEmberApp.testJavascript || asset.insertEmberApp.javascript);
      }
    }
    return additionalAssets;
  }

  private appDiffer: AppDiffer | undefined;

  private updateAppJS(appJSPath: string): Set<string> {
    if (!this.appDiffer) {
      this.appDiffer = new AppDiffer(this.root, appJSPath, this.activeAddonDescendants);
    }
    this.appDiffer.update();
    return this.appDiffer.files;
  }

  async build(inputPaths: OutputPaths<TreeNames>) {
    let appFiles = this.updateAppJS(this.adapter.ownJSPath());
    let config = this.adapter.config();

    let assets = this.adapter.assets(inputPaths);

    for (let asset of assets) {
      let destination = join(this.root, asset.relativePath);
      switch(asset.kind) {
        case 'dom':
          let additionalAssets = this.emitDOMAsset(config, appFiles, asset);
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
      externals: this.adapter.externals(),
      entrypoints: assets.map(a => a.relativePath),
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
  }
}

const entryTemplate = compile(`
{{!-
    This function is the entrypoint that final stage packagers should
    use to lookup externals at runtime.
-}}
let w = window;
let r = w.require;
let d = w.define;
w._vanilla_ = function(specifier) {
  let m;
  if (specifier === 'require') {
    m = r;
  } else {
    m = r(specifier);
  }
  {{!-
    There are plenty of hand-written AMD defines floating around
    that lack this, and they will break when other build systems
    encounter them.

    As far as I can tell, Ember's loader was already treating this
    case as a module, so in theory we aren't breaking anything by
    marking it as such when other packagers come looking.

    todo: get review on this part.
  -}}
  if (m.default && !m.__esModule) {
    m.__esModule = true;
  }
  return m;
};
{{#each lazyModules as |lazyModule| ~}}
  d("{{js-string-escape lazyModule.runtime}}", function(){ return require("{{js-string-escape lazyModule.buildtime}}");});
{{/each}}
{{#if autoRun ~}}
  require("{{js-string-escape mainModule}}").default.create({{{json-stringify appConfig}}});
{{/if}}
`);

const testTemplate = compile(`
{{#each testModules as |testModule| ~}}
  import "{{js-string-escape testModule}}";
{{/each}}

{{#if lazyModules}}
  let d = window.define;
{{/if}}
{{#each lazyModules as |lazyModule| ~}}
  d("{{js-string-escape lazyModule.runtime}}", function(){ return require("{{js-string-escape lazyModule.buildtime}}");});
{{/each}}

{{!- this is the traditioanl tests-suffix.js -}}
require('../tests/test-helper');
EmberENV.TESTS_FILE_LOADED = true;
`);

function assertNever(_: never) {}
