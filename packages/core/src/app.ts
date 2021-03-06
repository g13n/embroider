import { AppMeta } from './metadata';
import { OutputPaths } from './wait-for-trees';
import { compile } from './js-handlebars';
import Package from './package';
import sortBy from 'lodash/sortBy';
import resolve from 'resolve';
import { Memoize } from "typescript-memoize";
import { writeFileSync, ensureDirSync, copySync } from 'fs-extra';
import { join, dirname, relative } from 'path';
import { todo, unsupported } from './messages';
import cloneDeep from 'lodash/cloneDeep';
import AppDiffer from './app-differ';
import { getOrCreate } from './get-or-create';
import { PreparedEmberHTML } from './ember-html';
import { Asset, ImplicitAssetType, EmberAsset } from './asset';

export type EmberENV = unknown;

/*
  This interface is the boundary between the general-purpose build system in
  AppBuilder and the messy specifics of apps.

    - CompatAppAdapter in `@embroider/compat` implements this interface for
      building based of a legacy ember-cli EmberApp instance
    - We will want to make a different class that implmenets this interface for
      building apps that don't need an EmberApp instance at all (presumably
      because they opt into new authoring standards.
*/
export interface AppAdapter<TreeNames> {

  // path to the directory where the app's own Javascript lives. Doesn't include
  // any files copied out of addons, we take care of that generically in
  // AppBuilder.
  appJSSrcDir(treePaths: OutputPaths<TreeNames>): string;

  // this is where you declare what assets must be in the final output
  // (especially index.html, tests/index.html, and anything from your classic
  // public tree).
  assets(treePaths: OutputPaths<TreeNames>): Asset[];

  // whether the ember app should boot itself automatically
  autoRun(): boolean;

  // the ember app's main module
  mainModule(): string;

  // the configuration that will get passed into the ember app's main module.
  // This traditionally comes from the `APP` property returned by
  // config/environment.js.
  mainModuleConfig(): unknown;

  // The namespace for the app's own modules at runtime.
  //
  // (For apps, we _do_ still allow this to be arbitrary. This is in contrast
  // with _addons_, which absolutley must use their real NPM package name as
  // their modulePrefix.)
  modulePrefix(): string;

  // The scripts and styles that the app needs to be present, that aren't
  // otherwise directly imported or include via tags in the HTML. In a classic
  // application, this is the stuff that you included via `app.import()` in
  // ember-cli-build.js.
  impliedAssets(type: ImplicitAssetType): string[];

  // this is actual Javascript for a module that provides template compilation.
  // See how CompatAppAdapter does it for an example.
  templateCompilerSource(config: EmberENV): string;

  // this lets us figure out the babel config used by the app. You receive
  // "finalRoot" which is where the app will be when we run babel against it,
  // and you must make sure that the configuration will resolve correctly from
  // that path.
  //
  // - `config` is the actual babel configuration object.
  // - `syntheticPlugins` is a map from plugin names to Javascript source code
  //    for babel plugins. This can make it possible to serialize babel
  //    configs that would otherwise not be serializable.
  babelConfig(finalRoot: string): { config: { plugins: (string | [string,any])[]}, syntheticPlugins: Map<string, string> };

  // The environment settings used to control Ember itself. In a classic app,
  // this comes from the EmberENV property returned by config/environment.js.
  emberENV(): EmberENV;

  // the list of module specifiers that are used in the app that are not
  // resolvable at build time. This is how we figure out the "externals" for the
  // app itself as defined in SPEC.md.
  externals(): string[];
}

export class AppBuilder<TreeNames> {
  constructor(
    private root: string,
    private app: Package,
    private adapter: AppAdapter<TreeNames>
  ) {}

  @Memoize()
  private get activeAddonDescendants(): Package[] {
    // todo: filter by addon-provided hook
    return this.app.findDescendants(dep => dep.isEmberPackage);
  }

  private scriptPriority(pkg: Package) {
    switch (pkg.name) {
      case "loader.js":
        return 0;
      case "ember-source":
        return 10;
      default:
        return 1000;
    }
  }

  private impliedAssets(type: ImplicitAssetType): any {
    let appAssets = this.adapter.impliedAssets(type).map(mod => resolve.sync(mod, { basedir: this. root }));
    let result = this.impliedAddonAssets(type).concat(appAssets);

    // This file gets created by addEmberEnv(). We need to insert it at the
    // beginning of the scripts.
    if (type === "implicit-scripts") {
      result.unshift(join(this.root, "_ember_env_.js"));
    }
    return result;
  }

  private impliedAddonAssets(type: ImplicitAssetType): any {
    let result = [];
    for (let addon of sortBy(
      this.activeAddonDescendants,
      this.scriptPriority.bind(this)
    )) {
      let implicitScripts = addon.meta[type];
      if (implicitScripts) {
        for (let mod of implicitScripts) {
          result.push(resolve.sync(mod, { basedir: addon.root }));
        }
      }
    }
    return result;
  }

  @Memoize()
  private get babelConfig() {
    let rename = Object.assign(
      {},
      ...this.activeAddonDescendants.map(dep => dep.meta["renamed-modules"])
    );
    let babel = this.adapter.babelConfig(this.root);

    // this is our own plugin that patches up issues like non-explicit hbs
    // extensions and packages importing their own names.
    babel.config.plugins.push([require.resolve('./babel-plugin'), {
      ownName: this.app.name,
      basedir: this.root,
      rename
    }]);
    return babel;
  }

  private insertEmberApp(asset: EmberAsset, appFiles: Set<string>, jsEntrypoints: Map<string, Asset>): Asset[] {
    let newAssets: Asset[] = [];

    let appJS = getOrCreate(jsEntrypoints, `assets/${this.app.name}.js`, () => {
      let js = this.javascriptEntrypoint(this.app.name, appFiles);
      newAssets.push(js);
      return js;
    });

    let html = new PreparedEmberHTML(asset);

    html.insertScriptTag(html.javascript, appJS.relativePath, { type: 'module' });
    html.insertStyleLink(html.styles, `assets/${this.app.name}.css`);
    for (let script of this.impliedAssets("implicit-scripts")) {
      html.insertScriptTag(html.implicitScripts, relative(this.root, script));
    }
    for (let style of this.impliedAssets("implicit-styles")) {
      html.insertStyleLink(html.implicitStyles, relative(this.root, style));
    }

    if (asset.includeTests) {
      let testJS = getOrCreate(jsEntrypoints, `assets/test.js`, () => {
        let js = this.testJSEntrypoint(appFiles);
        newAssets.push(js);
        return js;
      });
      html.insertScriptTag(html.testJavascript, testJS.relativePath, { type: 'module' });
      for (let script of this.impliedAssets("implicit-test-scripts")) {
        html.insertScriptTag(html.implicitTestScripts, relative(this.root, script));
      }
      for (let style of this.impliedAssets("implicit-test-styles")) {
        html.insertStyleLink(html.implicitTestStyles, relative(this.root, style));
      }
    }

    newAssets.push({
      kind: 'in-memory',
      relativePath: asset.relativePath,
      source: html.dom.serialize()
    });

    return newAssets;
  }

  private appDiffer: AppDiffer | undefined;

  private updateAppJS(appJSPath: string): Set<string> {
    if (!this.appDiffer) {
      this.appDiffer = new AppDiffer(this.root, appJSPath, this.activeAddonDescendants);
    }
    this.appDiffer.update();
    return this.appDiffer.files;
  }

  private emitAsset(asset: Asset, appFiles: Set<string>, jsEntrypoints: Map<string, Asset>) {
    let destination = join(this.root, asset.relativePath);
    let newAssets: Asset[] = [];
    ensureDirSync(dirname(destination));
    switch (asset.kind) {
      case 'in-memory':
        writeFileSync(destination, asset.source, "utf8");
        break;
      case 'on-disk':
        copySync(asset.sourcePath, destination, { dereference: true });
        break;
      case 'ember':
        newAssets = this.insertEmberApp(asset, appFiles, jsEntrypoints);
        break;
      default:
        assertNever(asset);
    }
    return newAssets;
  }

  async build(inputPaths: OutputPaths<TreeNames>) {
    let appFiles = this.updateAppJS(this.adapter.appJSSrcDir(inputPaths));
    let emberENV = this.adapter.emberENV();
    let assets = this.adapter.assets(inputPaths);

    // this serves as a shared cache as we're filling out each of the html entrypoints
    let jsEntrypoints: Map<string, Asset> = new Map();

    let queue = assets.slice();
    while (queue.length > 0) {
      let asset = queue.shift()!;
      let newAssets = this.emitAsset(asset, appFiles, jsEntrypoints);
      queue = queue.concat(newAssets);
    }

    this.addTemplateCompiler(emberENV);
    this.addBabelConfig();
    this.addEmberEnv(emberENV);

    let externals = this.combineExternals();

    let meta: AppMeta = {
      version: 2,
      externals,
      assets: assets.map(a => a.relativePath),
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

  private combineExternals() {
    let allAddonNames = new Set(this.activeAddonDescendants.map(d => d.name));
    let externals = new Set();
    for (let addon of this.activeAddonDescendants) {
      if (!addon.meta.externals) {
        continue;
      }
      for (let name of addon.meta.externals) {
        if (allAddonNames.has(name)) {
          unsupported(`${addon.name} imports ${name} but does not directly depend on it.`);
        } else {
          externals.add(name);
        }
      }
    }

    for (let name of this.adapter.externals()) {
      if (allAddonNames.has(name)) {
        unsupported(`your app imports ${name} but does not directly depend on it.`);
      } else {
        externals.add(name);
      }
    }
    return [...externals.values()];
  }

  // we could just use ember-source/dist/ember-template-compiler directly, but
  // apparently ember-cli adds some extra steps on top (like stripping BOM), so
  // we follow along and do those too.
  private addTemplateCompiler(config: EmberENV) {
    writeFileSync(
      join(this.root, "_template_compiler_.js"),
      this.adapter.templateCompilerSource(config),
      "utf8"
    );
  }

  private addBabelConfig() {
    let { config, syntheticPlugins } = this.babelConfig;

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

  // this is stuff that needs to get set globally before Ember loads. In classic
  // Ember CLI it was "vendor-prefix" content that would go at the start of the
  // vendor.js. We are going to make sure it's the first plain <script> in the
  // HTML that we hand to the final stage packager.
  private addEmberEnv(config: EmberENV) {
    let content = `window.EmberENV=${JSON.stringify(config, null, 2)};`;
    writeFileSync(join(this.root, "_ember_env_.js"), content, "utf8");
  }

  private javascriptEntrypoint(name: string, appFiles: Set<string>): Asset {
    let modulePrefix = this.adapter.modulePrefix();
    // for the app tree, we take everything
    let lazyModules = [...appFiles].map(relativePath => {
      if (!relativePath.startsWith('tests/') && (relativePath.endsWith('.js') || relativePath.endsWith('.hbs'))) {
        let noJS = relativePath.replace(/\.js$/, "");
        let noHBS = noJS.replace(/\.hbs$/, "");
        return {
          runtime: `${modulePrefix}/${noHBS}`,
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

    let relativePath = `assets/${name}.js`;

    let source = entryTemplate({
      needsEmbroiderHook: true,
      lazyModules,
      autoRun: this.adapter.autoRun(),
      mainModule: relative(dirname(relativePath), this.adapter.mainModule()),
      appConfig: this.adapter.mainModuleConfig(),
    });

    return {
      kind: 'in-memory',
      source,
      relativePath,
    };
  }

  private testJSEntrypoint(appFiles: Set<string>): Asset {
    let testModules = [...appFiles].map(relativePath => {
      if (relativePath.startsWith("tests/") && relativePath.endsWith('-test.js')) {
        return `../${relativePath}`;
      }
    }).filter(Boolean) as string[];

    let lazyModules: { runtime: string, buildtime: string }[] = [];
    // this is a backward-compatibility feature: addons can force inclusion of
    // test support modules.
    this.gatherImplicitModules('implicit-test-modules', lazyModules);

    let source = entryTemplate({
      lazyModules,
      eagerModules: testModules,
      testSuffix: true
    });

    return {
      kind: 'in-memory',
      source,
      relativePath: 'assets/test.js'
    };
  }

  private gatherImplicitModules(section: "implicit-modules" | "implicit-test-modules", lazyModules: { runtime: string, buildtime: string }[]) {
    for (let addon of this.activeAddonDescendants) {
      let implicitModules = addon.meta[section];
      if (implicitModules) {
        for (let name of implicitModules) {
          lazyModules.push({
            runtime: join(addon.name, name),
            buildtime: relative(
              join(this.root, "assets"),
              join(addon.root, name)
            ),
          });
        }
      }
    }
  }
}

const entryTemplate = compile(`
let w = window;
let d = w.define;

{{#if needsEmbroiderHook}}
  {{!-
    This function is the entrypoint that final stage packagers should
    use to lookup externals at runtime.
  -}}
  w._embroider_ = function(specifier) {
    let m;
    if (specifier === 'require') {
      m = w.require;
    } else {
      m = w.require(specifier);
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
{{/if}}

{{#each eagerModules as |eagerModule| ~}}
  import "{{js-string-escape eagerModule}}";
{{/each}}

{{#each lazyModules as |lazyModule| ~}}
  d("{{js-string-escape lazyModule.runtime}}", function(){ return require("{{js-string-escape lazyModule.buildtime}}");});
{{/each}}

{{#if autoRun ~}}
  require("{{js-string-escape mainModule}}").default.create({{{json-stringify appConfig}}});
{{/if}}

{{#if testSuffix ~}}
  {{!- this is the traditional tests-suffix.js -}}
  require('../tests/test-helper');
  EmberENV.TESTS_FILE_LOADED = true;
{{/if}}
`);

function assertNever(_: never) {}
