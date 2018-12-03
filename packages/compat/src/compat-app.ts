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
import App, { Asset } from './app';

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

class Options {
  extraPublicTrees?: Tree[];
}

interface TreeNames {
  appJS: Tree;
  analyzer: Tree;
  htmlTree: Tree;
  publicTree: Tree;
  configTree: Tree;
}

class CompatAppBuilder extends App {

  // This runs at broccoli-pipeline-construction time, whereas our actual instance
  // only becomes available during actual tree-building time.
  static setup(legacyEmberAppInstance: object, options?: Options ) {
    let oldPackage = V1InstanceCache.forApp(legacyEmberAppInstance).app;

    let { analyzer, appJS } = oldPackage.processAppJS();
    let htmlTree = oldPackage.htmlTree;
    let publicTree = oldPackage.publicTree;
    let configTree = oldPackage.config;

    if (options && options.extraPublicTrees) {
      publicTree = mergeTrees([publicTree, ...options.extraPublicTrees]);
    }

    let inTrees = {
      appJS,
      analyzer,
      htmlTree,
      publicTree,
      configTree,
    };

    let instantiate = async (root: string, appSrcDir: string, packageCache: PackageCache) => {
      return new this(
        root,
        packageCache.getApp(appSrcDir),
        oldPackage,
        configTree,
        analyzer
      );
    };

    return { inTrees, instantiate };
  }

  constructor(
    root: string,
    app: Package,
    private oldPackage: V1App,
    private configTree: V1Config,
    private analyzer: DependencyAnalyzer
  ) {
    super(root, app);
  }

  protected config() {
    return this.configTree.readConfig();
  }

  protected assets(treePaths: OutputPaths<TreeNames>) {
    // Everything in our traditional public tree is an on-disk asset
    let assets: Asset[] = walkSync(treePaths.publicTree, {
      directories: false,
    }).map((file): Asset => ({
      kind: 'on-disk',
      relativePath: file,
      sourcePath: file
    }));

    // And we have our two traditional ember HTML entrypoints
    assets.push(this.emberEntrypoint(treePaths.htmlTree, 'index.html'));
    if (this.shouldBuildTests) {
      assets.push(this.emberEntrypoint(treePaths.htmlTree, 'tests/index.html'));
    }

    return assets;
  }

  protected copyAppJS(treePaths: OutputPaths<TreeNames>, dest: string) {
    copySync(treePaths.appJS, dest, { dereference: true });
  }

  // todo
  private shouldBuildTests = true;

  private get autoRun(): boolean {
    return this.oldPackage.autoRun;
  }

  private get isModuleUnification(): boolean {
    return this.oldPackage.isModuleUnification;
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

  private separateAssets(originalBundle: string): any {
    let group: "appJS" | "appCSS" | "testJS" | "testCSS";
    let metaKey:
      | "implicit-scripts"
      | "implicit-styles"
      | "implicit-test-scripts"
      | "implicit-test-styles";
    switch (originalBundle) {
      case "vendor.js":
        group = "appJS";
        metaKey = "implicit-scripts";
        break;
      case "vendor.css":
        group = "appCSS";
        metaKey = "implicit-styles";
        break;
      case "test-support.js":
        group = "testJS";
        metaKey = "implicit-test-scripts";
        break;
      case "test-support.css":
        group = "testCSS";
        metaKey = "implicit-test-styles";
        break;
      default:
        throw new Error(`unimplemented originalBundle ${originalBundle}`);
    }
    let result = [];
    for (let addon of sortBy(
      this.activeAddonDescendants,
      this.scriptPriority.bind(this)
    )) {
      let implicitScripts = addon.meta[metaKey];
      if (implicitScripts) {
        for (let mod of implicitScripts) {
          result.push(resolve.sync(mod, { basedir: addon.root }));
        }
      }
    }
    let imports = new TrackedImports(
      this.app.name,
      this.oldPackage.trackedImports
    );
    for (let mod of imports.categorized[group]) {
      result.push(resolve.sync(mod, { basedir: this.root }));
    }

    // This file gets created by addEmberEnv(). We need to insert it at the
    // beginning of the scripts.
    if (originalBundle === "vendor.js") {
      result.unshift(join(this.root, "_ember_env_.js"));
    }

    return result;
  }

  @Memoize()
  protected babelConfig(): { config: BabelConfig, syntheticPlugins: Map<string, string> } {
    let rename = Object.assign(
      {},
      ...this.activeAddonDescendants.map(dep => dep.meta["renamed-modules"])
    );
    return this.oldPackage.babelConfig(this.root, rename);
  }

  private emberEntrypoint(htmlTree: string, relativePath: string): Asset {
    let dom = new JSDOM(readFileSync(join(htmlTree, relativePath), "utf8"));
    return {
      kind: 'dom',
      relativePath,
      dom,
      insertEmberApp: this.prepareInsertion(dom)
    };
  }

  private maybeReplace(dom: JSDOM, element: Element | undefined) {
    if (element) {
      let placeholder = dom.window.document.createComment('');
      element.replaceWith(placeholder);
      return placeholder;
    }
  }

  private prepareInsertion(dom: JSDOM): AppInsertion {
    let scripts = [...dom.window.document.querySelectorAll("script")];
    let styles = [
      ...dom.window.document.querySelectorAll('link[rel="stylesheet"]'),
    ] as HTMLLinkElement[];

    return assertComplete({
      javascript: this.maybeReplace(dom, this.oldPackage.findAppScript(scripts)),
      styles: this.maybeReplace(dom, this.oldPackage.findAppStyles(styles)),
      implicitScripts: this.maybeReplace(dom, this.oldPackage.findVendorScript(scripts)),
      implicitStyles: this.maybeReplace(dom, this.oldPackage.findVendorStyles(styles)),
      testJavascript: this.maybeReplace(dom, this.oldPackage.findTestScript(scripts)),
      implicitTestScripts: this.maybeReplace(dom, this.oldPackage.findTestSupportScript(scripts)),
      implicitTestStyles: this.maybeReplace(dom, this.oldPackage.findTestSupportStyles(styles)),
    });
  }

  private updateHTML(entrypoint: string, dom: JSDOM) {
    let scripts = [...dom.window.document.querySelectorAll("script")];
    this.updateAppJS(entrypoint, scripts);
    this.updateTestJS(entrypoint, scripts);
    this.updateJS(
      dom,
      entrypoint,
      this.oldPackage.findVendorScript(scripts),
      "vendor.js"
    );
    this.updateJS(
      dom,
      entrypoint,
      this.oldPackage.findTestSupportScript(scripts),
      "test-support.js"
    );

    let styles = [
      ...dom.window.document.querySelectorAll('link[rel="stylesheet"]'),
    ] as HTMLLinkElement[];
    this.updateAppCSS(entrypoint, styles);
    this.updateCSS(
      dom,
      entrypoint,
      this.oldPackage.findVendorStyles(styles),
      "vendor.css"
    );
    this.updateCSS(
      dom,
      entrypoint,
      this.oldPackage.findTestSupportStyles(styles),
      "test-support.css"
    );
  }

  private updateAppJS(entrypoint: string, scripts: HTMLScriptElement[]) {
    // no custom name allowed here -- we're standardizing. It's not the final
    // output anyway, that will be up to the final stage packager. We also
    // switch to module type, to convey that we're going to point at an ES
    // module.
    let appJS = this.oldPackage.findAppScript(scripts);
    if (appJS) {
      appJS.src = relative(
        dirname(join(this.root, entrypoint)),
        join(this.root, `assets/${this.app.name}.js`)
      );
      appJS.type = "module";
    }
  }

  private updateTestJS(entrypoint: string, scripts: HTMLScriptElement[]) {
    let testJS = this.oldPackage.findTestScript(scripts);
    if (testJS) {
      testJS.src = relative(
        dirname(join(this.root, entrypoint)),
        join(this.root, `assets/test.js`)
      );
      testJS.type = "module";
    }
  }

  private updateJS(
    dom: JSDOM,
    entrypoint: string,
    original: HTMLScriptElement | undefined,
    bundleName: string
  ) {
    // the vendor.js file gets replaced with each of our implicit scripts. It's
    // up to the final stage packager to worry about concatenation.
    if (!original) {
      return;
    }
    for (let insertedScript of this.separateAssets(bundleName)) {
      let s = dom.window.document.createElement("script");
      s.src = relative(dirname(join(this.root, entrypoint)), insertedScript);
      // these newlines make the output more readable
      original.parentElement!.insertBefore(
        dom.window.document.createTextNode("\n"),
        original
      );
      original.parentElement!.insertBefore(s, original);
    }
    original.remove();
  }

  private updateAppCSS(entrypoint: string, styles: HTMLLinkElement[]) {
    // no custom name allowed here. Same argument applies here as for appJS
    // above.
    let appCSS = this.oldPackage.findAppStyles(styles);
    if (appCSS) {
      appCSS.href = relative(
        dirname(join(this.root, entrypoint)),
        join(this.root, `assets/${this.app.name}.css`)
      );
    }
  }

  private updateCSS(
    dom: JSDOM,
    entrypoint: string,
    original: HTMLLinkElement | undefined,
    bundleName: string
  ) {
    // the vendor.css file gets replaced with each of our implicit CSS
    // dependencies. It's up to the final stage packager to worry about
    // concatenation.
    if (!original) {
      return;
    }
    for (let insertedStyle of this.separateAssets(bundleName)) {
      let s = dom.window.document.createElement("link");
      s.rel = "stylesheet";
      s.href = relative(dirname(join(this.root, entrypoint)), insertedStyle);
      original.parentElement!.insertBefore(
        dom.window.document.createTextNode("\n"),
        original
      );
      original.parentElement!.insertBefore(s, original);
    }
    original.remove();
  }

  private emberEntrypoints(): string[] {
    let entrypoints = ["index.html"];
    if (this.shouldBuildTests) {
      entrypoints.push("tests/index.html");
    }
    return entrypoints;
  }

  protected externals(): string[] {
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

    for (let name of this.analyzer.externals) {
      if (allAddonNames.has(name)) {
        unsupported(`your app imports ${name} but does not directly depend on it.`);
      } else {
        externals.add(name);
      }
    }
    return [...externals.values()];
  }

  protected templateCompilerSource(config: EmberENV) {
    let plugins = this.oldPackage.htmlbarsPlugins;
    (global as any).__embroiderHtmlbarsPlugins__ = plugins;
    return `
    var compiler = require('ember-source/vendor/ember/ember-template-compiler');
    var setupCompiler = require('@embroider/core/src/template-compiler').default;
    var EmberENV = ${JSON.stringify(config)};
    var plugins = global.__embroiderHtmlbarsPlugins__;
    if (!plugins) {
      throw new Error('You must run your final stage packager in the same process as CompatApp, because there are unserializable AST plugins');
    }
    module.exports = setupCompiler(compiler, EmberENV, plugins);
    `;
  }

  private writeAppJSEntrypoint(config: ConfigContents) {
    let mainModule = join(
      this.root,
      this.isModuleUnification ? "src/main" : "app"
    );
    // standard JS file name, not customizable. It's not final anyway (that is
    // up to the final stage packager). See also updateHTML in app.ts for where
    // we're enforcing this in the HTML.
    let appJS = join(this.root, `assets/${this.app.name}.js`);

    // for the app tree, we take everything
    let lazyModules = walkSync(this.root, {
      globs: ["**/*.{js,hbs}"],
      ignore: ["tests", "node_modules"],
      directories: false,
    }).map(specifier => {
      let noJS = specifier.replace(/\.js$/, "");
      let noHBS = noJS.replace(/\.hbs$/, "");
      return {
        runtime: `${config.modulePrefix}/${noHBS}`,
        buildtime: `../${noJS}`,
      };
    });

    // for the src tree, we can limit ourselves to only known resolvable
    // collections
    todo("app src tree");

    // this is a backward-compatibility feature: addons can force inclusion of
    // modules.
    this.gatherImplicitModules('implicit-modules', lazyModules);

    ensureDirSync(dirname(appJS));
    writeFileSync(
      appJS,
      entryTemplate({
        lazyModules,
        autoRun: this.autoRun,
        mainModule: relative(dirname(appJS), mainModule),
        appConfig: config.APP,
      }),
      "utf8"
    );
  }

  private writeTestJSEntrypoint() {
    let testJS = join(this.root, `assets/test.js`);
    let testModules = walkSync(this.root, {
      globs: ["tests/**/*-test.js"],
      directories: false,
    }).map(specifier => `../${specifier}`);

    let lazyModules: { runtime: string, buildtime: string }[] = [];
    // this is a backward-compatibility feature: addons can force inclusion of
    // test support modules.
    this.gatherImplicitModules('implicit-test-modules', lazyModules);

    ensureDirSync(dirname(testJS));
    writeFileSync(
      testJS,
      testTemplate({
        testModules,
        lazyModules
      }),
      "utf8"
    );
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
              `${addon.root}/${name}`
            ),
          });
        }
      }
    }
  }
}

export default class CompatApp extends BuildStage<TreeNames> {
  constructor(legacyEmberAppInstance: object, addons: Stage, options?: Options) {
    let { inTrees, instantiate } = CompatAppBuilder.setup(legacyEmberAppInstance, options);
    super(addons, inTrees, instantiate);
  }
}

// This isn't trying to be complete, it only shows the bare minimum that we are
// touching.
interface BabelConfig {
  plugins: string[];
}
