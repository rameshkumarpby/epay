/*
GOAL: This module should mirror the NodeJS module system according the documented behavior.
The module transport will send down code that registers module definitions by an assigned path. In addition,
the module transport will send down code that registers additional metadata to allow the module resolver to
resolve modules in the browser. Additional metadata includes the following:

- "mains": The mapping of module directory paths to a fully resolved module path
- "remaps": The remapping of one fully resolved module path to another fully resolved module path (used for browser overrides)
- "run": A list of entry point modules that should be executed when ready

Inspired by:
https://github.com/joyent/node/blob/master/lib/module.js
*/
(function() {
    var win;

    if (typeof window !== 'undefined') {
        win = window;

        // This lasso modules client has already been loaded on the page. Do nothing;
        if (win.$_mod) {
            return;
        }

        win.global = win;
    }

    /** the module runtime */
    var $_mod;

    // this object stores the module factories with the keys being module paths and
    // values being a factory function or object (e.g. "/baz$3.0.0/lib/index" --> Function)
    var definitions = {};

    // Search path that will be checked when looking for modules
    var searchPaths = [];

    // The _ready flag is used to determine if "run" modules can
    // be executed or if they should be deferred until all dependencies
    // have been loaded
    var _ready = false;

    // If $_mod.run() is called when the page is not ready then
    // we queue up the run modules to be executed later
    var runQueue = [];

    // this object stores the Module instance cache with the keys being paths of modules (e.g., "/foo$1.0.0/bar" --> Module)
    var instanceCache = {};

    // This object maps installed dependencies to specific versions
    //
    // For example:
    // {
    //   // The package "foo" with version 1.0.0 has an installed package named "bar" (foo/node_modules/bar") and
    //   // the version of "bar" is 3.0.0
    //   "/foo$1.0.0/bar": "3.0.0"
    // }
    var installed = {};

    // Maps builtin modules such as "path", "buffer" to their fully resolved paths
    var builtins = {};

    // this object maps a directory to the fully resolved module path
    //
    // For example:
    //
    var mains = {};

    // used to remap a one fully resolved module path to another fully resolved module path
    var remapped = {};

    var cacheByDirname = {};

    // When a module is mapped to a global varialble we add a reference
    // that maps the path of the module to the loaded global instance.
    // We use this mapping to ensure that global modules are only loaded
    // once if they map to the same path.
    //
    // See issue #5 - Ensure modules mapped to globals only load once
    // https://github.com/raptorjs/raptor-modules/issues/5
    var loadedGlobalsByRealPath = {};

    function moduleNotFoundError(target, from) {
        var err = new Error('Cannot find module "' + target + '"' + (from ? ' from "' + from + '"' : ''));

        err.code = 'MODULE_NOT_FOUND';
        return err;
    }

    function Module(filename) {
       /*
        A Node module has these properties:
        - filename: The path of the module
        - id: The path of the module (same as filename)
        - exports: The exports provided during load
        - loaded: Has module been fully loaded (set to false until factory function returns)

        NOT SUPPORTED:
        - parent: parent Module
        - paths: The search path used by this module (NOTE: not documented in Node.js module system so we don't need support)
        - children: The modules that were required by this module
        */
        this.id = this.filename = filename;
        this.loaded = false;
        this.exports = undefined;
    }

    Module.cache = instanceCache;

    // temporary variable for referencing the Module prototype
    var Module_prototype = Module.prototype;

    Module_prototype.load = function(factoryOrObject) {
        var filename = this.id;

        if (factoryOrObject && factoryOrObject.constructor === Function) {
            // factoryOrObject is definitely a function
            var lastSlashPos = filename.lastIndexOf('/');

            // find the value for the __dirname parameter to factory
            var dirname = filename.substring(0, lastSlashPos);

            // local cache for requires initiated from this module/dirname
            var localCache = cacheByDirname[dirname] || (cacheByDirname[dirname] = {});

            // this is the require used by the module
            var instanceRequire = function(target) {
                // Only store the `module` in the local cache since `module.exports` may not be accurate
                // if there was a circular dependency
                var module = localCache[target] || (localCache[target] = requireModule(target, dirname));
                return module.exports;
            };

            // The require method should have a resolve method that will return the resolved
            // path but not actually instantiate the module.
            // This resolve function will make sure a definition exists for the corresponding
            // path of the target but it will not instantiate a new instance of the target.
            instanceRequire.resolve = function(target) {
                if (!target) {
                    throw moduleNotFoundError('');
                }

                var resolved = resolve(target, dirname);

                if (!resolved) {
                    throw moduleNotFoundError(target, dirname);
                }

                // NOTE: resolved[0] is the path and resolved[1] is the module factory
                return resolved[0];
            };

            // NodeJS provides access to the cache as a property of the "require" function
            instanceRequire.cache = instanceCache;

            // Expose the module system runtime via the `runtime` property
            // TODO: We should deprecate this in favor of `Module.prototype.__runtime`
            // @deprecated
            instanceRequire.runtime = $_mod;

            // $_mod.def("/foo$1.0.0/lib/index", function(require, exports, module, __filename, __dirname) {
            this.exports = {};

            // call the factory function
            factoryOrObject.call(this, instanceRequire, this.exports, this, filename, dirname);
        } else {
            // factoryOrObject is not a function so have exports reference factoryOrObject
            this.exports = factoryOrObject;
        }

        this.loaded = true;
    };

    /**
     * Defines a packages whose metadata is used by raptor-loader to load the package.
     */
    function define(path, factoryOrObject, options) {
        /*
        $_mod.def('/baz$3.0.0/lib/index', function(require, exports, module, __filename, __dirname) {
            // module source code goes here
        });
        */

        var globals = options && options.globals;

        definitions[path] = factoryOrObject;

        if (globals) {
            var target = win || global;
            for (var i=0;i<globals.length; i++) {
                var globalVarName = globals[i];
                var globalModule = loadedGlobalsByRealPath[path] = requireModule(path);
                target[globalVarName] = globalModule.exports;
            }
        }
    }

    function registerMain(path, relativePath) {
        mains[path] = relativePath;
    }

    function remap(fromPath, toPath) {
        remapped[fromPath] = toPath;
    }

    function builtin(name, target) {
        builtins[name] = target;
    }

    function registerInstalledDependency(parentPath, packageName, packageVersion) {
        // Example:
        // dependencies['/my-package$1.0.0/$/my-installed-package'] = '2.0.0'
        installed[parentPath + '/' + packageName] =  packageVersion;
    }

    /**
     * This function will take an array of path parts and normalize them by handling handle ".." and "."
     * and then joining the resultant string.
     *
     * @param {Array} parts an array of parts that presumedly was split on the "/" character.
     */
    function normalizePathParts(parts) {

        // IMPORTANT: It is assumed that parts[0] === "" because this method is used to
        // join an absolute path to a relative path
        var i;
        var len = 0;

        var numParts = parts.length;

        for (i = 0; i < numParts; i++) {
            var part = parts[i];

            if (part === '.') {
                // ignore parts with just "."
                /*
                // if the "." is at end of parts (e.g. ["a", "b", "."]) then trim it off
                if (i === numParts - 1) {
                    //len--;
                }
                */
            } else if (part === '..') {
                // overwrite the previous item by decrementing length
                len--;
            } else {
                // add this part to result and increment length
                parts[len] = part;
                len++;
            }
        }

        if (len === 1) {
            // if we end up with just one part that is empty string
            // (which can happen if input is ["", "."]) then return
            // string with just the leading slash
            return '/';
        } else if (len > 2) {
            // parts i s
            // ["", "a", ""]
            // ["", "a", "b", ""]
            if (parts[len - 1].length === 0) {
                // last part is an empty string which would result in trailing slash
                len--;
            }
        }

        // truncate parts to remove unused
        parts.length = len;
        return parts.join('/');
    }

    function join(from, target) {
        var targetParts = target.split('/');
        var fromParts = from == '/' ? [''] : from.split('/');
        return normalizePathParts(fromParts.concat(targetParts));
    }

    function withoutExtension(path) {
        var lastDotPos = path.lastIndexOf('.');
        var lastSlashPos;

        /* jshint laxbreak:true */
        return ((lastDotPos === -1) || ((lastSlashPos = path.lastIndexOf('/')) !== -1) && (lastSlashPos > lastDotPos))
            ? null // use null to indicate that returned path is same as given path
            : path.substring(0, lastDotPos);
    }

    function splitPackageIdAndSubpath(path) {
        path = path.substring(1); /* Skip past the first slash */
        // Examples:
        //     '/my-package$1.0.0/foo/bar' --> ['my-package$1.0.0', '/foo/bar']
        //     '/my-package$1.0.0' --> ['my-package$1.0.0', '']
        //     '/my-package$1.0.0/' --> ['my-package$1.0.0', '/']
        //     '/@my-scoped-package/foo/$1.0.0/' --> ['@my-scoped-package/foo$1.0.0', '/']
        var slashPos = path.indexOf('/');

        if (path.charAt(1) === '@') {
            // path is something like "/@my-user-name/my-scoped-package/subpath"
            // For scoped packages, the package name is two parts. We need to skip
            // past the second slash to get the full package name
            slashPos = path.indexOf('/', slashPos+1);
        }

        var packageIdEnd = slashPos === -1 ? path.length : slashPos;

        return [
            path.substring(0, packageIdEnd), // Everything up to the slash
            path.substring(packageIdEnd) // Everything after the package ID
        ];
    }

    function resolveInstalledModule(target, from) {
        // Examples:
        // target='foo', from='/my-package$1.0.0/hello/world'

        if (target.charAt(target.length-1) === '/') {
            // This is a hack because I found require('util/') in the wild and
            // it did not work because of the trailing slash
            target = target.slice(0, -1);
        }

        // Check to see if the target module is a builtin module.
        // For example:
        // builtins['path'] = '/path-browserify$0.0.0/index'
        var builtinPath = builtins[target];
        if (builtinPath) {
            return builtinPath;
        }

        var fromParts = splitPackageIdAndSubpath(from);
        var fromPackageId = fromParts[0];


        var targetSlashPos = target.indexOf('/');
        var targetPackageName;
        var targetSubpath;

        if (targetSlashPos < 0) {
            targetPackageName = target;
            targetSubpath = '';
        } else {

            if (target.charAt(0) === '@') {
                // target is something like "@my-user-name/my-scoped-package/subpath"
                // For scoped packages, the package name is two parts. We need to skip
                // past the first slash to get the full package name
                targetSlashPos = target.indexOf('/', targetSlashPos + 1);
            }

            targetPackageName = target.substring(0, targetSlashPos);
            targetSubpath = target.substring(targetSlashPos);
        }

        var targetPackageVersion = installed[fromPackageId + '/' + targetPackageName];
        if (targetPackageVersion) {
            var resolvedPath = '/' + targetPackageName + '$' + targetPackageVersion;
            if (targetSubpath) {
                resolvedPath += targetSubpath;
            }
            return resolvedPath;
        }
    }

    function resolve(target, from) {
        var resolvedPath;

        if (target.charAt(0) === '.') {
            // turn relative path into absolute path
            resolvedPath = join(from, target);
        } else if (target.charAt(0) === '/') {
            // handle targets such as "/my/file" or "/$/foo/$/baz"
            resolvedPath = normalizePathParts(target.split('/'));
        } else {
            var len = searchPaths.length;
            for (var i = 0; i < len; i++) {
                // search path entries always end in "/";
                var candidate = searchPaths[i] + target;
                var resolved = resolve(candidate, from);
                if (resolved) {
                    return resolved;
                }
            }

            resolvedPath = resolveInstalledModule(target, from);
        }

        if (!resolvedPath) {
            return undefined;
        }

        // target is something like "/foo/baz"
        // There is no installed module in the path
        var relativePath;

        // check to see if "target" is a "directory" which has a registered main file
        if ((relativePath = mains[resolvedPath]) !== undefined) {
            if (!relativePath) {
                relativePath = 'index';
            }

            // there is a main file corresponding to the given target so add the relative path
            resolvedPath = join(resolvedPath, relativePath);
        }

        var remappedPath = remapped[resolvedPath];
        if (remappedPath) {
            resolvedPath = remappedPath;
        }

        var factoryOrObject = definitions[resolvedPath];
        if (factoryOrObject === undefined) {
            // check for definition for given path but without extension
            var resolvedPathWithoutExtension;
            if (((resolvedPathWithoutExtension = withoutExtension(resolvedPath)) === null) ||
                ((factoryOrObject = definitions[resolvedPathWithoutExtension]) === undefined)) {
                return undefined;
            }

            // we found the definition based on the path without extension so
            // update the path
            resolvedPath = resolvedPathWithoutExtension;
        }

        return [resolvedPath, factoryOrObject];
    }

    function requireModule(target, from) {
        if (!target) {
            throw moduleNotFoundError('');
        }

        var resolved = resolve(target, from);
        if (!resolved) {
            throw moduleNotFoundError(target, from);
        }

        var resolvedPath = resolved[0];

        var module = instanceCache[resolvedPath];

        if (module !== undefined) {
            // found cached entry based on the path
            return module;
        }

        // Fixes issue #5 - Ensure modules mapped to globals only load once
        // https://github.com/raptorjs/raptor-modules/issues/5
        //
        // If a module is mapped to a global variable then we want to always
        // return that global instance of the module when it is being required
        // to avoid duplicate modules being loaded. For modules that are mapped
        // to global variables we also add an entry that maps the path
        // of the module to the global instance of the loaded module.

        if (loadedGlobalsByRealPath.hasOwnProperty(resolvedPath)) {
            return loadedGlobalsByRealPath[resolvedPath];
        }

        var factoryOrObject = resolved[1];

        module = new Module(resolvedPath);

        // cache the instance before loading (allows support for circular dependency with partial loading)
        instanceCache[resolvedPath] = module;

        module.load(factoryOrObject);

        return module;
    }

    function require(target, from) {
        var module = requireModule(target, from);
        return module.exports;
    }

    /*
    $_mod.run('/$/installed-module', '/src/foo');
    */
    function run(path, options) {
        var wait = !options || (options.wait !== false);
        if (wait && !_ready) {
            return runQueue.push([path, options]);
        }

        require(path, '/');
    }

    /*
     * Mark the page as being ready and execute any of the
     * run modules that were deferred
     */
    function ready() {
        _ready = true;

        var len;
        while((len = runQueue.length)) {
            // store a reference to the queue before we reset it
            var queue = runQueue;

            // clear out the queue
            runQueue = [];

            // run all of the current jobs
            for (var i = 0; i < len; i++) {
                var args = queue[i];
                run(args[0], args[1]);
            }

            // stop running jobs in the queue if we change to not ready
            if (!_ready) {
                break;
            }
        }
    }

    function addSearchPath(prefix) {
        searchPaths.push(prefix);
    }

    var pendingCount = 0;
    var onPendingComplete = function() {
        pendingCount--;
        if (!pendingCount) {
            // Trigger any "require-run" modules in the queue to run
            ready();
        }
    };

    /*
     * $_mod is the short-hand version that that the transport layer expects
     * to be in the browser window object
     */
    Module_prototype.__runtime = $_mod = {
        /**
         * Used to register a module factory/object (*internal*)
         */
        def: define,

        /**
         * Used to register an installed dependency (e.g. "/$/foo" depends on "baz") (*internal*)
         */
        installed: registerInstalledDependency,
        run: run,
        main: registerMain,
        remap: remap,
        builtin: builtin,
        require: require,
        resolve: resolve,
        join: join,
        ready: ready,

        /**
         * Add a search path entry (internal)
         */
        searchPath: addSearchPath,

        /**
         * Sets the loader metadata for this build.
         *
         * @param asyncPackageName {String} name of asynchronous package
         * @param contentType {String} content type ("js" or "css")
         * @param bundleUrl {String} URL of bundle that belongs to package
         */
        loaderMetadata: function(data) {
            // We store loader metadata in the prototype of Module
            // so that `lasso-loader` can read it from
            // `module.__loaderMetadata`.
            Module_prototype.__loaderMetadata = data;
        },

        /**
         * Asynchronous bundle loaders should call `pending()` to instantiate
         * a new job. The object we return here has a `done` method that
         * should be called when the job completes. When the number of
         * pending jobs drops to 0, we invoke any of the require-run modules
         * that have been declared.
         */
        pending: function() {
            _ready = false;
            pendingCount++;
            return {
                done: onPendingComplete
            };
        }
    };

    if (win) {
        win.$_mod = $_mod;
    } else {
        module.exports = $_mod;
    }
})();

$_mod.installed("app$1.0.0", "marko", "4.18.10");
$_mod.remap("/marko$4.18.10/components", "/marko$4.18.10/components-browser.marko");
$_mod.main("/marko$4.18.10/dist/runtime/components", "");
$_mod.remap("/marko$4.18.10/dist/runtime/components/index", "/marko$4.18.10/dist/runtime/components/index-browser");
$_mod.remap("/marko$4.18.10/dist/runtime/components/util", "/marko$4.18.10/dist/runtime/components/util-browser");
$_mod.def("/marko$4.18.10/dist/runtime/components/dom-data", function(require, exports, module, __filename, __dirname) { var counter = 0;
var seed = require.resolve('/marko$4.18.10/dist/runtime/components/dom-data'/*"./dom-data"*/);
var WeakMap = global.WeakMap || function WeakMap() {
    var id = seed + counter++;
    return {
        get: function (ref) {
            return ref[id];
        },
        set: function (ref, value) {
            ref[id] = value;
        }
    };
};

module.exports = {
    _Y_: new WeakMap(),
    _Z_: new WeakMap(),
    G_: new WeakMap(),
    a__: new WeakMap(),
    aa_: new WeakMap()
};
});
$_mod.def("/marko$4.18.10/dist/runtime/components/util-browser", function(require, exports, module, __filename, __dirname) { var domData = require('/marko$4.18.10/dist/runtime/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.G_;
var keysByDOMNode = domData.aa_;
var vElementsByDOMNode = domData._Z_;
var vPropsByDOMNode = domData._Y_;
var markoUID = window.$MUID || (window.$MUID = { i: 0 });
var runtimeId = markoUID.i++;

var componentLookup = {};

var defaultDocument = document;
var EMPTY_OBJECT = {};

function getComponentForEl(el, doc) {
    if (el) {
        var node = typeof el == "string" ? (doc || defaultDocument).getElementById(el) : el;
        if (node) {
            var vElement = vElementsByDOMNode.get(node);
            return vElement && vElement.aC_;
        }
    }
}

var lifecycleEventMethods = {};

["create", "render", "update", "mount", "destroy"].forEach(function (eventName) {
    lifecycleEventMethods[eventName] = "on" + eventName[0].toUpperCase() + eventName.substring(1);
});

/**
 * This method handles invoking a component's event handler method
 * (if present) while also emitting the event through
 * the standard EventEmitter.prototype.emit method.
 *
 * Special events and their corresponding handler methods
 * include the following:
 *
 * beforeDestroy --> onBeforeDestroy
 * destroy       --> onDestroy
 * beforeUpdate  --> onBeforeUpdate
 * update        --> onUpdate
 * render        --> onRender
 */
function emitLifecycleEvent(component, eventType, eventArg1, eventArg2) {
    var listenerMethod = component[lifecycleEventMethods[eventType]];

    if (listenerMethod !== undefined) {
        listenerMethod.call(component, eventArg1, eventArg2);
    }

    component.emit(eventType, eventArg1, eventArg2);
}

function destroyComponentForNode(node) {
    var componentToDestroy = componentsByDOMNode.get(node.fragment || node);
    if (componentToDestroy) {
        componentToDestroy.___();
        delete componentLookup[componentToDestroy.id];
    }
}
function destroyNodeRecursive(node, component) {
    destroyComponentForNode(node);
    if (node.nodeType === 1 || node.nodeType === 12) {
        var key;

        if (component && (key = keysByDOMNode.get(node))) {
            if (node === component.m_[key]) {
                if (componentsByDOMNode.get(node) && /\[\]$/.test(key)) {
                    delete component.m_[key][componentsByDOMNode.get(node).id];
                } else {
                    delete component.m_[key];
                }
            }
        }

        var curChild = node.firstChild;
        while (curChild && curChild !== node.endNode) {
            destroyNodeRecursive(curChild, component);
            curChild = curChild.nextSibling;
        }
    }
}

function nextComponentId() {
    // Each component will get an ID that is unique across all loaded
    // marko runtimes. This allows multiple instances of marko to be
    // loaded in the same window and they should all place nice
    // together
    return "c" + markoUID.i++;
}

function nextComponentIdProvider() {
    return nextComponentId;
}

function attachBubblingEvent(componentDef, handlerMethodName, isOnce, extraArgs) {
    if (handlerMethodName) {
        var componentId = componentDef.id;
        if (extraArgs) {
            return [handlerMethodName, componentId, isOnce, extraArgs];
        } else {
            return [handlerMethodName, componentId, isOnce];
        }
    }
}

function getMarkoPropsFromEl(el) {
    var vElement = vElementsByDOMNode.get(el);
    var virtualProps;

    if (vElement) {
        virtualProps = vElement.aD_;
    } else {
        virtualProps = vPropsByDOMNode.get(el);
        if (!virtualProps) {
            virtualProps = el.getAttribute("data-marko");
            vPropsByDOMNode.set(el, virtualProps = virtualProps ? JSON.parse(virtualProps) : EMPTY_OBJECT);
        }
    }

    return virtualProps;
}

function normalizeComponentKey(key, parentId) {
    if (key[0] === "#") {
        key = key.replace("#" + parentId + "-", "");
    }
    return key;
}

function addComponentRootToKeyedElements(keyedElements, key, rootNode, componentId) {
    if (/\[\]$/.test(key)) {
        var repeatedElementsForKey = keyedElements[key] = keyedElements[key] || {};
        repeatedElementsForKey[componentId] = rootNode;
    } else {
        keyedElements[key] = rootNode;
    }
}

exports.ab_ = runtimeId;
exports.h_ = componentLookup;
exports.af_ = getComponentForEl;
exports.E_ = emitLifecycleEvent;
exports.aE_ = destroyComponentForNode;
exports.F_ = destroyNodeRecursive;
exports._O_ = nextComponentIdProvider;
exports._y_ = attachBubblingEvent;
exports.ac_ = getMarkoPropsFromEl;
exports.aj_ = addComponentRootToKeyedElements;
exports.aF_ = normalizeComponentKey;
});
$_mod.remap("/marko$4.18.10/dist/runtime/components/init-components", "/marko$4.18.10/dist/runtime/components/init-components-browser");
$_mod.installed("marko$4.18.10", "warp10", "2.0.1");
$_mod.def("/warp10$2.0.1/src/constants", function(require, exports, module, __filename, __dirname) { var win = typeof window !== "undefined" ? window : global;
exports.NOOP = win.$W10NOOP = win.$W10NOOP || function () {};
});
$_mod.def("/warp10$2.0.1/src/finalize", function(require, exports, module, __filename, __dirname) { var constants = require('/warp10$2.0.1/src/constants'/*"./constants"*/);
var isArray = Array.isArray;

function resolve(object, path, len) {
    var current = object;
    for (var i=0; i<len; i++) {
        current = current[path[i]];
    }

    return current;
}

function resolveType(info) {
    if (info.type === 'Date') {
        return new Date(info.value);
    } else if (info.type === 'NOOP') {
        return constants.NOOP;
    } else {
        throw new Error('Bad type');
    }
}

module.exports = function finalize(outer) {
    if (!outer) {
        return outer;
    }

    var assignments = outer.$$;
    if (assignments) {
        var object = outer.o;
        var len;

        if (assignments && (len=assignments.length)) {
            for (var i=0; i<len; i++) {
                var assignment = assignments[i];

                var rhs = assignment.r;
                var rhsValue;

                if (isArray(rhs)) {
                    rhsValue = resolve(object, rhs, rhs.length);
                } else {
                    rhsValue = resolveType(rhs);
                }

                var lhs = assignment.l;
                var lhsLast = lhs.length-1;

                if (lhsLast === -1) {
                    object = outer.o = rhsValue;
                    break;
                } else {
                    var lhsParent = resolve(object, lhs, lhsLast);
                    lhsParent[lhs[lhsLast]] = rhsValue;
                }
            }
        }

        assignments.length = 0; // Assignments have been applied, do not reapply

        return object == null ? null : object;
    } else {
        return outer;
    }

};
});
$_mod.def("/warp10$2.0.1/finalize", function(require, exports, module, __filename, __dirname) { module.exports = require('/warp10$2.0.1/src/finalize'/*'./src/finalize'*/);
});
$_mod.def("/marko$4.18.10/dist/runtime/components/event-delegation", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.18.10/dist/runtime/components/util-browser'/*"./util"*/);
var runtimeId = componentsUtil.ab_;
var componentLookup = componentsUtil.h_;
var getMarkoPropsFromEl = componentsUtil.ac_;

// We make our best effort to allow multiple marko runtimes to be loaded in the
// same window. Each marko runtime will get its own unique runtime ID.
var listenersAttachedKey = "$MDE" + runtimeId;
var delegatedEvents = {};

function getEventFromEl(el, eventName) {
    var virtualProps = getMarkoPropsFromEl(el);
    var eventInfo = virtualProps[eventName];

    if (typeof eventInfo === "string") {
        eventInfo = eventInfo.split(" ");
        if (eventInfo[2]) {
            eventInfo[2] = eventInfo[2] === "true";
        }
        if (eventInfo.length == 4) {
            eventInfo[3] = parseInt(eventInfo[3], 10);
        }
    }

    return eventInfo;
}

function delegateEvent(node, eventName, target, event) {
    var targetMethod = target[0];
    var targetComponentId = target[1];
    var isOnce = target[2];
    var extraArgs = target[3];

    if (isOnce) {
        var virtualProps = getMarkoPropsFromEl(node);
        delete virtualProps[eventName];
    }

    var targetComponent = componentLookup[targetComponentId];

    if (!targetComponent) {
        return;
    }

    var targetFunc = typeof targetMethod === "function" ? targetMethod : targetComponent[targetMethod];
    if (!targetFunc) {
        throw Error("Method not found: " + targetMethod);
    }

    if (extraArgs != null) {
        if (typeof extraArgs === "number") {
            extraArgs = targetComponent.N_[extraArgs];
        }
    }

    // Invoke the component method
    if (extraArgs) {
        targetFunc.apply(targetComponent, extraArgs.concat(event, node));
    } else {
        targetFunc.call(targetComponent, event, node);
    }
}

function addDelegatedEventHandler(eventType) {
    if (!delegatedEvents[eventType]) {
        delegatedEvents[eventType] = true;
    }
}

function addDelegatedEventHandlerToDoc(eventType, doc) {
    var body = doc.body || doc;
    var listeners = doc[listenersAttachedKey] = doc[listenersAttachedKey] || {};
    if (!listeners[eventType]) {
        body.addEventListener(eventType, listeners[eventType] = function (event) {
            var propagationStopped = false;

            // Monkey-patch to fix #97
            var oldStopPropagation = event.stopPropagation;

            event.stopPropagation = function () {
                oldStopPropagation.call(event);
                propagationStopped = true;
            };

            var curNode = event.target;
            if (!curNode) {
                return;
            }

            // event.target of an SVGElementInstance does not have a
            // `getAttribute` function in IE 11.
            // See https://github.com/marko-js/marko/issues/796
            curNode = curNode.correspondingUseElement || curNode;

            // Search up the tree looking DOM events mapped to target
            // component methods
            var propName = "on" + eventType;
            var target;

            // Attributes will have the following form:
            // on<event_type>("<target_method>|<component_id>")

            do {
                if (target = getEventFromEl(curNode, propName)) {
                    delegateEvent(curNode, propName, target, event);

                    if (propagationStopped) {
                        break;
                    }
                }
            } while ((curNode = curNode.parentNode) && curNode.getAttribute);
        }, true);
    }
}

function noop() {}

exports._X_ = noop;
exports._a_ = noop;
exports._U_ = delegateEvent;
exports._V_ = getEventFromEl;
exports._z_ = addDelegatedEventHandler;
exports.ad_ = function (doc) {
    Object.keys(delegatedEvents).forEach(function (eventType) {
        addDelegatedEventHandlerToDoc(eventType, doc);
    });
};
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/morphdom/helpers", function(require, exports, module, __filename, __dirname) { function insertBefore(node, referenceNode, parentNode) {
    if (node.insertInto) {
        return node.insertInto(parentNode, referenceNode);
    }
    return parentNode.insertBefore(node, referenceNode && referenceNode.startNode || referenceNode);
}

function insertAfter(node, referenceNode, parentNode) {
    return insertBefore(node, referenceNode && referenceNode.nextSibling, parentNode);
}

function nextSibling(node) {
    var next = node.nextSibling;
    var fragment = next && next.fragment;
    if (fragment) {
        return next === fragment.startNode ? fragment : null;
    }
    return next;
}

function firstChild(node) {
    var next = node.firstChild;
    return next && next.fragment || next;
}

function removeChild(node) {
    if (node.remove) node.remove();else node.parentNode.removeChild(node);
}

exports.aH_ = insertBefore;
exports.aI_ = insertAfter;
exports.b_ = nextSibling;
exports.a_ = firstChild;
exports.aJ_ = removeChild;
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/morphdom/fragment", function(require, exports, module, __filename, __dirname) { var helpers = require('/marko$4.18.10/dist/runtime/vdom/morphdom/helpers'/*"./helpers"*/);
var insertBefore = helpers.aH_;

var fragmentPrototype = {
    nodeType: 12,
    get firstChild() {
        var firstChild = this.startNode.nextSibling;
        return firstChild === this.endNode ? undefined : firstChild;
    },
    get lastChild() {
        var lastChild = this.endNode.previousSibling;
        return lastChild === this.startNode ? undefined : lastChild;
    },
    get parentNode() {
        var parentNode = this.startNode.parentNode;
        return parentNode === this.detachedContainer ? undefined : parentNode;
    },
    get namespaceURI() {
        return this.startNode.parentNode.namespaceURI;
    },
    get nextSibling() {
        return this.endNode.nextSibling;
    },
    get nodes() {
        var nodes = [];
        var current = this.startNode;
        while (current !== this.endNode) {
            nodes.push(current);
            current = current.nextSibling;
        }
        nodes.push(current);
        return nodes;
    },
    insertBefore: function (newChildNode, referenceNode) {
        var actualReference = referenceNode == null ? this.endNode : referenceNode;
        return insertBefore(newChildNode, actualReference, this.startNode.parentNode);
    },
    insertInto: function (newParentNode, referenceNode) {
        this.nodes.forEach(function (node) {
            insertBefore(node, referenceNode, newParentNode);
        }, this);
        return this;
    },
    remove: function () {
        this.nodes.forEach(function (node) {
            this.detachedContainer.appendChild(node);
        }, this);
    }
};

function createFragmentNode(startNode, nextNode, parentNode) {
    var fragment = Object.create(fragmentPrototype);
    fragment.startNode = document.createTextNode("");
    fragment.endNode = document.createTextNode("");
    fragment.startNode.fragment = fragment;
    fragment.endNode.fragment = fragment;
    var detachedContainer = fragment.detachedContainer = document.createDocumentFragment();
    parentNode = parentNode || startNode && startNode.parentNode || detachedContainer;
    insertBefore(fragment.startNode, startNode, parentNode);
    insertBefore(fragment.endNode, nextNode, parentNode);
    return fragment;
}

function beginFragmentNode(startNode, parentNode) {
    var fragment = createFragmentNode(startNode, null, parentNode);
    fragment.bO_ = function (nextNode) {
        fragment.bO_ = null;
        insertBefore(fragment.endNode, nextNode, parentNode || startNode.parentNode);
    };
    return fragment;
}

exports.ai_ = createFragmentNode;
exports.bP_ = beginFragmentNode;
});
$_mod.installed("marko$4.18.10", "raptor-util", "3.2.0");
$_mod.def("/raptor-util$3.2.0/extend", function(require, exports, module, __filename, __dirname) { module.exports = function extend(target, source) { //A simple function to copy properties from one object to another
    if (!target) { //Check if a target was provided, otherwise create a new empty object to return
        target = {};
    }

    if (source) {
        for (var propName in source) {
            if (source.hasOwnProperty(propName)) { //Only look at source properties that are not inherited
                target[propName] = source[propName]; //Copy the property
            }
        }
    }

    return target;
};
});
$_mod.def("/marko$4.18.10/dist/runtime/components/KeySequence", function(require, exports, module, __filename, __dirname) { function KeySequence() {
    this._Q_ = {};
}

KeySequence.prototype = {
    c_: function (key) {
        // var len = key.length;
        // var lastChar = key[len-1];
        // if (lastChar === ']') {
        //     key = key.substring(0, len-2);
        // }
        var lookup = this._Q_;

        var currentIndex = lookup[key]++;
        if (!currentIndex) {
            lookup[key] = 1;
            currentIndex = 0;
            return key;
        } else {
            return key + "_" + currentIndex;
        }
    }
};

module.exports = KeySequence;
});
$_mod.def("/marko$4.18.10/dist/runtime/components/ComponentDef", function(require, exports, module, __filename, __dirname) { "use strict";

var complain;
var componentUtil = require('/marko$4.18.10/dist/runtime/components/util-browser'/*"./util"*/);
var attachBubblingEvent = componentUtil._y_;
var addDelegatedEventHandler = require('/marko$4.18.10/dist/runtime/components/event-delegation'/*"./event-delegation"*/)._z_;
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);
var KeySequence = require('/marko$4.18.10/dist/runtime/components/KeySequence'/*"./KeySequence"*/);

var FLAG_WILL_RERENDER_IN_BROWSER = 1;
// var FLAG_HAS_BODY_EL = 2;
// var FLAG_HAS_HEAD_EL = 4;
var FLAG_OLD_HYDRATE_NO_CREATE = 8;

/**
 * A ComponentDef is used to hold the metadata collected at runtime for
 * a single component and this information is used to instantiate the component
 * later (after the rendered HTML has been added to the DOM)
 */
function ComponentDef(component, componentId, globalComponentsContext) {
    this._A_ = globalComponentsContext; // The AsyncWriter that this component is associated with
    this.k_ = component;
    this.id = componentId;

    this._B_ = undefined; // An array of DOM events that need to be added (in sets of three)

    this._C_ = false;

    this._D_ = false;
    this.g_ = 0;

    this._E_ = 0; // The unique integer to use for the next scoped ID

    this.Y_ = null;

    this._F_ = null;
}

ComponentDef.prototype = {
    c_: function (key) {
        var keySequence = this.Y_ || (this.Y_ = new KeySequence());
        return keySequence.c_(key);
    },

    _G_: function (key, bodyOnly) {
        var lookup = this._F_ || (this._F_ = {});
        lookup[key] = bodyOnly ? 2 : 1;
    },

    /**
     * This helper method generates a unique and fully qualified DOM element ID
     * that is unique within the scope of the current component.
     */
    elId: function (nestedId) {
        var id = this.id;

        if (nestedId == null) {
            return id;
        } else {
            if (typeof nestedId !== "string") {

                nestedId = String(nestedId);
                // eslint-disable-next-line no-constant-condition
            }

            if (nestedId.indexOf("#") === 0) {
                id = "#" + id;
                nestedId = nestedId.substring(1);
            }

            return id + "-" + nestedId;
        }
    },
    /**
     * Returns the next auto generated unique ID for a nested DOM element or nested DOM component
     */
    _H_: function () {
        return this.id + "-c" + this._E_++;
    },

    d: function (eventName, handlerMethodName, isOnce, extraArgs) {
        addDelegatedEventHandler(eventName);
        return attachBubblingEvent(this, handlerMethodName, isOnce, extraArgs);
    },

    get f_() {
        return this.k_.f_;
    }
};

ComponentDef._I_ = function (o, types, global, registry) {
    var id = o[0];
    var typeName = types[o[1]];
    var input = o[2];
    var extra = o[3];

    var isLegacy = extra.l;
    var state = extra.s;
    var componentProps = extra.w;
    var flags = extra.f;

    var component = typeName /* legacy */ && registry._J_(typeName, id, isLegacy);

    // Prevent newly created component from being queued for update since we area
    // just building it from the server info
    component.U_ = true;

    if (!isLegacy && flags & FLAG_WILL_RERENDER_IN_BROWSER && !(flags & FLAG_OLD_HYDRATE_NO_CREATE)) {
        if (component.onCreate) {
            component.onCreate(input, { global: global });
        }
        if (component.onInput) {
            input = component.onInput(input, { global: global }) || input;
        }
    } else {
        if (state) {
            var undefinedPropNames = extra.u;
            if (undefinedPropNames) {
                undefinedPropNames.forEach(function (undefinedPropName) {
                    state[undefinedPropName] = undefined;
                });
            }
            // We go through the setter here so that we convert the state object
            // to an instance of `State`
            component.state = state;
        }

        if (componentProps) {
            extend(component, componentProps);
        }
    }

    component.Q_ = input;

    if (extra.b) {
        component.N_ = extra.b;
    }

    var scope = extra.p;
    var customEvents = extra.e;
    if (customEvents) {
        component._v_(customEvents, scope);
    }

    component.S_ = global;

    return {
        id: id,
        k_: component,
        _K_: extra.r,
        _B_: extra.d,
        g_: extra.f || 0
    };
};

module.exports = ComponentDef;
});
$_mod.remap("/marko$4.18.10/dist/runtime/components/registry", "/marko$4.18.10/dist/runtime/components/registry-browser");
$_mod.def("/marko$4.18.10/dist/runtime/components/State", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function ensure(state, propertyName) {
    var proto = state.constructor.prototype;
    if (!(propertyName in proto)) {
        Object.defineProperty(proto, propertyName, {
            get: function () {
                return this._u_[propertyName];
            },
            set: function (value) {
                this._f_(propertyName, value, false /* ensure:false */);
            }
        });
    }
}

function State(component) {
    this.k_ = component;
    this._u_ = {};

    this.V_ = false;
    this._l_ = null;
    this._k_ = null;
    this._T_ = null; // An object that we use to keep tracking of state properties that were forced to be dirty

    Object.seal(this);
}

State.prototype = {
    I_: function () {
        var self = this;

        self.V_ = false;
        self._l_ = null;
        self._k_ = null;
        self._T_ = null;
    },

    _d_: function (newState) {
        var state = this;
        var key;

        var rawState = this._u_;

        for (key in rawState) {
            if (!(key in newState)) {
                state._f_(key, undefined, false /* ensure:false */
                , false /* forceDirty:false */
                );
            }
        }

        for (key in newState) {
            state._f_(key, newState[key], true /* ensure:true */
            , false /* forceDirty:false */
            );
        }
    },
    _f_: function (name, value, shouldEnsure, forceDirty) {
        var rawState = this._u_;

        if (shouldEnsure) {
            ensure(this, name);
        }

        if (forceDirty) {
            var forcedDirtyState = this._T_ || (this._T_ = {});
            forcedDirtyState[name] = true;
        } else if (rawState[name] === value) {
            return;
        }

        if (!this.V_) {
            // This is the first time we are modifying the component state
            // so introduce some properties to do some tracking of
            // changes to the state
            this.V_ = true; // Mark the component state as dirty (i.e. modified)
            this._l_ = rawState;
            this._u_ = rawState = extend({}, rawState);
            this._k_ = {};
            this.k_._e_();
        }

        this._k_[name] = value;

        if (value === undefined) {
            // Don't store state properties with an undefined or null value
            delete rawState[name];
        } else {
            // Otherwise, store the new value in the component state
            rawState[name] = value;
        }
    },
    toJSON: function () {
        return this._u_;
    }
};

module.exports = State;
});
$_mod.def("/marko$4.18.10/dist/runtime/dom-insert", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);
var componentsUtil = require('/marko$4.18.10/dist/runtime/components/util-browser'/*"./components/util"*/);
var destroyComponentForNode = componentsUtil.aE_;
var destroyNodeRecursive = componentsUtil.F_;
var helpers = require('/marko$4.18.10/dist/runtime/vdom/morphdom/helpers'/*"./vdom/morphdom/helpers"*/);

var insertBefore = helpers.aH_;
var insertAfter = helpers.aI_;
var removeChild = helpers.aJ_;

function resolveEl(el) {
    if (typeof el == "string") {
        var elId = el;
        el = document.getElementById(elId);
        if (!el) {
            throw Error("Not found: " + elId);
        }
    }
    return el;
}

function beforeRemove(referenceEl) {
    destroyNodeRecursive(referenceEl);
    destroyComponentForNode(referenceEl);
}

module.exports = function (target, getEl, afterInsert) {
    extend(target, {
        appendTo: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertBefore(el, null, referenceEl);
            return afterInsert(this, referenceEl);
        },
        prependTo: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertBefore(el, referenceEl.firstChild || null, referenceEl);
            return afterInsert(this, referenceEl);
        },
        replace: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            beforeRemove(referenceEl);
            insertBefore(el, referenceEl, referenceEl.parentNode);
            removeChild(referenceEl);
            return afterInsert(this, referenceEl);
        },
        replaceChildrenOf: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);

            var curChild = referenceEl.firstChild;
            while (curChild) {
                var nextSibling = curChild.nextSibling; // Just in case the DOM changes while removing
                beforeRemove(curChild);
                curChild = nextSibling;
            }

            referenceEl.innerHTML = "";
            insertBefore(el, null, referenceEl);
            return afterInsert(this, referenceEl);
        },
        insertBefore: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertBefore(el, referenceEl, referenceEl.parentNode);
            return afterInsert(this, referenceEl);
        },
        insertAfter: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertAfter(el, referenceEl, referenceEl.parentNode);
            return afterInsert(this, referenceEl);
        }
    });
};
});
$_mod.def("/marko$4.18.10/dist/runtime/createOut", function(require, exports, module, __filename, __dirname) { var actualCreateOut;

function setCreateOut(createOutFunc) {
    actualCreateOut = createOutFunc;
}

function createOut(globalData) {
    return actualCreateOut(globalData);
}

createOut.aG_ = setCreateOut;

module.exports = createOut;
});
$_mod.def("/marko$4.18.10/dist/runtime/components/GlobalComponentsContext", function(require, exports, module, __filename, __dirname) { var nextComponentIdProvider = require('/marko$4.18.10/dist/runtime/components/util-browser'/*"./util"*/)._O_;
var KeySequence = require('/marko$4.18.10/dist/runtime/components/KeySequence'/*"./KeySequence"*/);

function GlobalComponentsContext(out) {
    this.o_ = {};
    this.n_ = {};
    this.q_ = {};
    this._q_ = undefined;
    this._H_ = nextComponentIdProvider(out);
}

GlobalComponentsContext.prototype = {
    _P_: function () {
        return new KeySequence();
    }
};

module.exports = GlobalComponentsContext;
});
$_mod.def("/marko$4.18.10/dist/runtime/components/ComponentsContext", function(require, exports, module, __filename, __dirname) { "use strict";

var GlobalComponentsContext = require('/marko$4.18.10/dist/runtime/components/GlobalComponentsContext'/*"./GlobalComponentsContext"*/);

function ComponentsContext(out, parentComponentsContext) {
    var globalComponentsContext;
    var componentDef;

    if (parentComponentsContext) {
        globalComponentsContext = parentComponentsContext.l_;
        componentDef = parentComponentsContext.j_;

        var nestedContextsForParent;
        if (!(nestedContextsForParent = parentComponentsContext._L_)) {
            nestedContextsForParent = parentComponentsContext._L_ = [];
        }

        nestedContextsForParent.push(this);
    } else {
        globalComponentsContext = out.global.i_;
        if (globalComponentsContext === undefined) {
            out.global.i_ = globalComponentsContext = new GlobalComponentsContext(out);
        }
    }

    this.l_ = globalComponentsContext;
    this.i_ = [];
    this.z_ = out;
    this.j_ = componentDef;
    this._L_ = undefined;
}

ComponentsContext.prototype = {
    A_: function (doc) {
        var componentDefs = this.i_;

        ComponentsContext._M_(componentDefs, doc);

        this.z_.emit("_N_");

        // Reset things stored in global since global is retained for
        // future renders
        this.z_.global.i_ = undefined;

        return componentDefs;
    }
};

function getComponentsContext(out) {
    return out.i_ || (out.i_ = new ComponentsContext(out));
}

module.exports = exports = ComponentsContext;

exports.D_ = getComponentsContext;
});
$_mod.installed("marko$4.18.10", "events-light", "1.0.5");
$_mod.main("/events-light$1.0.5", "src/index");
$_mod.def("/events-light$1.0.5/src/index", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var slice = Array.prototype.slice;

function isFunction(arg) {
    return typeof arg === 'function';
}

function checkListener(listener) {
    if (!isFunction(listener)) {
        throw TypeError('Invalid listener');
    }
}

function invokeListener(ee, listener, args) {
    switch (args.length) {
        // fast cases
        case 1:
            listener.call(ee);
            break;
        case 2:
            listener.call(ee, args[1]);
            break;
        case 3:
            listener.call(ee, args[1], args[2]);
            break;
            // slower
        default:
            listener.apply(ee, slice.call(args, 1));
    }
}

function addListener(eventEmitter, type, listener, prepend) {
    checkListener(listener);

    var events = eventEmitter.$e || (eventEmitter.$e = {});

    var listeners = events[type];
    if (listeners) {
        if (isFunction(listeners)) {
            events[type] = prepend ? [listener, listeners] : [listeners, listener];
        } else {
            if (prepend) {
                listeners.unshift(listener);
            } else {
                listeners.push(listener);
            }
        }

    } else {
        events[type] = listener;
    }
    return eventEmitter;
}

function EventEmitter() {
    this.$e = this.$e || {};
}

EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype = {
    $e: null,

    emit: function(type) {
        var args = arguments;

        var events = this.$e;
        if (!events) {
            return;
        }

        var listeners = events && events[type];
        if (!listeners) {
            // If there is no 'error' event listener then throw.
            if (type === 'error') {
                var error = args[1];
                if (!(error instanceof Error)) {
                    var context = error;
                    error = new Error('Error: ' + context);
                    error.context = context;
                }

                throw error; // Unhandled 'error' event
            }

            return false;
        }

        if (isFunction(listeners)) {
            invokeListener(this, listeners, args);
        } else {
            listeners = slice.call(listeners);

            for (var i=0, len=listeners.length; i<len; i++) {
                var listener = listeners[i];
                invokeListener(this, listener, args);
            }
        }

        return true;
    },

    on: function(type, listener) {
        return addListener(this, type, listener, false);
    },

    prependListener: function(type, listener) {
        return addListener(this, type, listener, true);
    },

    once: function(type, listener) {
        checkListener(listener);

        function g() {
            this.removeListener(type, g);

            if (listener) {
                listener.apply(this, arguments);
                listener = null;
            }
        }

        this.on(type, g);

        return this;
    },

    // emits a 'removeListener' event iff the listener was removed
    removeListener: function(type, listener) {
        checkListener(listener);

        var events = this.$e;
        var listeners;

        if (events && (listeners = events[type])) {
            if (isFunction(listeners)) {
                if (listeners === listener) {
                    delete events[type];
                }
            } else {
                for (var i=listeners.length-1; i>=0; i--) {
                    if (listeners[i] === listener) {
                        listeners.splice(i, 1);
                    }
                }
            }
        }

        return this;
    },

    removeAllListeners: function(type) {
        var events = this.$e;
        if (events) {
            delete events[type];
        }
    },

    listenerCount: function(type) {
        var events = this.$e;
        var listeners = events && events[type];
        return listeners ? (isFunction(listeners) ? 1 : listeners.length) : 0;
    }
};

module.exports = EventEmitter;
});
$_mod.def("/marko$4.18.10/dist/runtime/RenderResult", function(require, exports, module, __filename, __dirname) { var domInsert = require('/marko$4.18.10/dist/runtime/dom-insert'/*"./dom-insert"*/);

function getComponentDefs(result) {
    var componentDefs = result.i_;

    if (!componentDefs) {
        throw Error("No component");
    }
    return componentDefs;
}

function RenderResult(out) {
    this.out = this.z_ = out;
    this.i_ = undefined;
}

module.exports = RenderResult;

var proto = RenderResult.prototype = {
    getComponent: function () {
        return this.getComponents()[0];
    },
    getComponents: function (selector) {
        if (this.i_ === undefined) {
            throw Error("Not added to DOM");
        }

        var componentDefs = getComponentDefs(this);

        var components = [];

        componentDefs.forEach(function (componentDef) {
            var component = componentDef.k_;
            if (!selector || selector(component)) {
                components.push(component);
            }
        });

        return components;
    },

    afterInsert: function (doc) {
        var out = this.z_;
        var componentsContext = out.i_;
        if (componentsContext) {
            this.i_ = componentsContext.A_(doc);
        } else {
            this.i_ = null;
        }

        return this;
    },
    getNode: function (doc) {
        return this.z_.B_(doc);
    },
    getOutput: function () {
        return this.z_.C_();
    },
    toString: function () {
        return this.z_.toString();
    },
    document: typeof document != "undefined" && document
};

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(proto, function getEl(renderResult, referenceEl) {
    return renderResult.getNode(referenceEl.ownerDocument);
}, function afterInsert(renderResult, referenceEl) {
    var isShadow = typeof ShadowRoot === "function" && referenceEl instanceof ShadowRoot;
    return renderResult.afterInsert(isShadow ? referenceEl : referenceEl.ownerDocument);
});
});
$_mod.installed("marko$4.18.10", "listener-tracker", "2.0.0");
$_mod.main("/listener-tracker$2.0.0", "lib/listener-tracker");
$_mod.def("/listener-tracker$2.0.0/lib/listener-tracker", function(require, exports, module, __filename, __dirname) { var INDEX_EVENT = 0;
var INDEX_USER_LISTENER = 1;
var INDEX_WRAPPED_LISTENER = 2;
var DESTROY = "destroy";

function isNonEventEmitter(target) {
  return !target.once;
}

function EventEmitterWrapper(target) {
    this.$__target = target;
    this.$__listeners = [];
    this.$__subscribeTo = null;
}

EventEmitterWrapper.prototype = {
    $__remove: function(test, testWrapped) {
        var target = this.$__target;
        var listeners = this.$__listeners;

        this.$__listeners = listeners.filter(function(curListener) {
            var curEvent = curListener[INDEX_EVENT];
            var curListenerFunc = curListener[INDEX_USER_LISTENER];
            var curWrappedListenerFunc = curListener[INDEX_WRAPPED_LISTENER];

            if (testWrapped) {
                // If the user used `once` to attach an event listener then we had to
                // wrap their listener function with a new function that does some extra
                // cleanup to avoid a memory leak. If the `testWrapped` flag is set to true
                // then we are attempting to remove based on a function that we had to
                // wrap (not the user listener function)
                if (curWrappedListenerFunc && test(curEvent, curWrappedListenerFunc)) {
                    target.removeListener(curEvent, curWrappedListenerFunc);

                    return false;
                }
            } else if (test(curEvent, curListenerFunc)) {
                // If the listener function was wrapped due to it being a `once` listener
                // then we should remove from the target EventEmitter using wrapped
                // listener function. Otherwise, we remove the listener using the user-provided
                // listener function.
                target.removeListener(curEvent, curWrappedListenerFunc || curListenerFunc);

                return false;
            }

            return true;
        });

        // Fixes https://github.com/raptorjs/listener-tracker/issues/2
        // If all of the listeners stored with a wrapped EventEmitter
        // have been removed then we should unregister the wrapped
        // EventEmitter in the parent SubscriptionTracker
        var subscribeTo = this.$__subscribeTo;

        if (!this.$__listeners.length && subscribeTo) {
            var self = this;
            var subscribeToList = subscribeTo.$__subscribeToList;
            subscribeTo.$__subscribeToList = subscribeToList.filter(function(cur) {
                return cur !== self;
            });
        }
    },

    on: function(event, listener) {
        this.$__target.on(event, listener);
        this.$__listeners.push([event, listener]);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // Handling a `once` event listener is a little tricky since we need to also
        // do our own cleanup if the `once` event is emitted. Therefore, we need
        // to wrap the user's listener function with our own listener function.
        var wrappedListener = function() {
            self.$__remove(function(event, listenerFunc) {
                return wrappedListener === listenerFunc;
            }, true /* We are removing the wrapped listener */);

            listener.apply(this, arguments);
        };

        this.$__target.once(event, wrappedListener);
        this.$__listeners.push([event, listener, wrappedListener]);
        return this;
    },

    removeListener: function(event, listener) {
        if (typeof event === 'function') {
            listener = event;
            event = null;
        }

        if (listener && event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent && listener === curListener;
            });
        } else if (listener) {
            this.$__remove(function(curEvent, curListener) {
                return listener === curListener;
            });
        } else if (event) {
            this.removeAllListeners(event);
        }

        return this;
    },

    removeAllListeners: function(event) {

        var listeners = this.$__listeners;
        var target = this.$__target;

        if (event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent;
            });
        } else {
            for (var i = listeners.length - 1; i >= 0; i--) {
                var cur = listeners[i];
                target.removeListener(cur[INDEX_EVENT], cur[INDEX_USER_LISTENER]);
            }
            this.$__listeners.length = 0;
        }

        return this;
    }
};

function EventEmitterAdapter(target) {
    this.$__target = target;
}

EventEmitterAdapter.prototype = {
    on: function(event, listener) {
        this.$__target.addEventListener(event, listener);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // need to save this so we can remove it below
        var onceListener = function() {
          self.$__target.removeEventListener(event, onceListener);
          listener();
        };
        this.$__target.addEventListener(event, onceListener);
        return this;
    },

    removeListener: function(event, listener) {
        this.$__target.removeEventListener(event, listener);
        return this;
    }
};

function SubscriptionTracker() {
    this.$__subscribeToList = [];
}

SubscriptionTracker.prototype = {

    subscribeTo: function(target, options) {
        var addDestroyListener = !options || options.addDestroyListener !== false;
        var wrapper;
        var nonEE;
        var subscribeToList = this.$__subscribeToList;

        for (var i=0, len=subscribeToList.length; i<len; i++) {
            var cur = subscribeToList[i];
            if (cur.$__target === target) {
                wrapper = cur;
                break;
            }
        }

        if (!wrapper) {
            if (isNonEventEmitter(target)) {
              nonEE = new EventEmitterAdapter(target);
            }

            wrapper = new EventEmitterWrapper(nonEE || target);
            if (addDestroyListener && !nonEE) {
                wrapper.once(DESTROY, function() {
                    wrapper.removeAllListeners();

                    for (var i = subscribeToList.length - 1; i >= 0; i--) {
                        if (subscribeToList[i].$__target === target) {
                            subscribeToList.splice(i, 1);
                            break;
                        }
                    }
                });
            }

            // Store a reference to the parent SubscriptionTracker so that we can do cleanup
            // if the EventEmitterWrapper instance becomes empty (i.e., no active listeners)
            wrapper.$__subscribeTo = this;
            subscribeToList.push(wrapper);
        }

        return wrapper;
    },

    removeAllListeners: function(target, event) {
        var subscribeToList = this.$__subscribeToList;
        var i;

        if (target) {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                var cur = subscribeToList[i];
                if (cur.$__target === target) {
                    cur.removeAllListeners(event);

                    if (!cur.$__listeners.length) {
                        // Do some cleanup if we removed all
                        // listeners for the target event emitter
                        subscribeToList.splice(i, 1);
                    }

                    break;
                }
            }
        } else {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                subscribeToList[i].removeAllListeners();
            }
            subscribeToList.length = 0;
        }
    }
};

exports = module.exports = SubscriptionTracker;

exports.wrap = function(targetEventEmitter) {
    var nonEE;
    var wrapper;

    if (isNonEventEmitter(targetEventEmitter)) {
      nonEE = new EventEmitterAdapter(targetEventEmitter);
    }

    wrapper = new EventEmitterWrapper(nonEE || targetEventEmitter);
    if (!nonEE) {
      // we don't set this for non EE types
      targetEventEmitter.once(DESTROY, function() {
          wrapper.$__listeners.length = 0;
      });
    }

    return wrapper;
};

exports.createTracker = function() {
    return new SubscriptionTracker();
};

});
$_mod.def("/raptor-util$3.2.0/copyProps", function(require, exports, module, __filename, __dirname) { module.exports = function copyProps(from, to) {
    Object.getOwnPropertyNames(from).forEach(function(name) {
        var descriptor = Object.getOwnPropertyDescriptor(from, name);
        Object.defineProperty(to, name, descriptor);
    });
};
});
$_mod.def("/raptor-util$3.2.0/inherit", function(require, exports, module, __filename, __dirname) { var copyProps = require('/raptor-util$3.2.0/copyProps'/*'./copyProps'*/);

function inherit(ctor, superCtor, shouldCopyProps) {
    var oldProto = ctor.prototype;
    var newProto = ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
            value: ctor,
            writable: true,
            configurable: true
        }
    });
    if (oldProto && shouldCopyProps !== false) {
        copyProps(oldProto, newProto);
    }
    ctor.$super = superCtor;
    ctor.prototype = newProto;
    return ctor;
}


module.exports = inherit;
inherit._inherit = inherit;

});
$_mod.remap("/marko$4.18.10/dist/runtime/nextTick", "/marko$4.18.10/dist/runtime/nextTick-browser");
$_mod.def("/marko$4.18.10/dist/runtime/nextTick-browser", function(require, exports, module, __filename, __dirname) { /* globals window */

var win = window;
var setImmediate = win.setImmediate;

if (!setImmediate) {
    if (win.postMessage) {
        var queue = [];
        var messageName = "si";
        win.addEventListener("message", function (event) {
            var source = event.source;
            if (source == win || !source && event.data === messageName) {
                event.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        setImmediate = function (fn) {
            queue.push(fn);
            win.postMessage(messageName, "*");
        };
    } else {
        setImmediate = setTimeout;
    }
}

module.exports = setImmediate;
});
$_mod.def("/marko$4.18.10/dist/runtime/components/update-manager", function(require, exports, module, __filename, __dirname) { "use strict";

var updatesScheduled = false;
var batchStack = []; // A stack of batched updates
var unbatchedQueue = []; // Used for scheduled batched updates

var nextTick = require('/marko$4.18.10/dist/runtime/nextTick-browser'/*"../nextTick"*/);

/**
 * This function is called when we schedule the update of "unbatched"
 * updates to components.
 */
function updateUnbatchedComponents() {
    if (unbatchedQueue.length) {
        try {
            updateComponents(unbatchedQueue);
        } finally {
            // Reset the flag now that this scheduled batch update
            // is complete so that we can later schedule another
            // batched update if needed
            updatesScheduled = false;
        }
    }
}

function scheduleUpdates() {
    if (updatesScheduled) {
        // We have already scheduled a batched update for the
        // process.nextTick so nothing to do
        return;
    }

    updatesScheduled = true;

    nextTick(updateUnbatchedComponents);
}

function updateComponents(queue) {
    // Loop over the components in the queue and update them.
    // NOTE: It is okay if the queue grows during the iteration
    //       since we will still get to them at the end
    for (var i = 0; i < queue.length; i++) {
        var component = queue[i];
        component._w_(); // Do the actual component update
    }

    // Clear out the queue by setting the length to zero
    queue.length = 0;
}

function batchUpdate(func) {
    // If the batched update stack is empty then this
    // is the outer batched update. After the outer
    // batched update completes we invoke the "afterUpdate"
    // event listeners.
    var batch = {
        aB_: null
    };

    batchStack.push(batch);

    try {
        func();
    } finally {
        try {
            // Update all of the components that where queued up
            // in this batch (if any)
            if (batch.aB_) {
                updateComponents(batch.aB_);
            }
        } finally {
            // Now that we have completed the update of all the components
            // in this batch we need to remove it off the top of the stack
            batchStack.length--;
        }
    }
}

function queueComponentUpdate(component) {
    var batchStackLen = batchStack.length;

    if (batchStackLen) {
        // When a batch update is started we push a new batch on to a stack.
        // If the stack has a non-zero length then we know that a batch has
        // been started so we can just queue the component on the top batch. When
        // the batch is ended this component will be updated.
        var batch = batchStack[batchStackLen - 1];

        // We default the batch queue to null to avoid creating an Array instance
        // unnecessarily. If it is null then we create a new Array, otherwise
        // we push it onto the existing Array queue
        if (batch.aB_) {
            batch.aB_.push(component);
        } else {
            batch.aB_ = [component];
        }
    } else {
        // We are not within a batched update. We need to schedule a batch update
        // for the process.nextTick (if that hasn't been done already) and we will
        // add the component to the unbatched queued
        scheduleUpdates();
        unbatchedQueue.push(component);
    }
}

exports._i_ = queueComponentUpdate;
exports._o_ = batchUpdate;
});
$_mod.main("/marko$4.18.10/dist/runtime/vdom/morphdom", "");
$_mod.def("/marko$4.18.10/dist/runtime/vdom/morphdom/specialElHandlers", function(require, exports, module, __filename, __dirname) { function syncBooleanAttrProp(fromEl, toEl, name) {
    if (fromEl[name] !== toEl[name]) {
        fromEl[name] = toEl[name];
        if (fromEl[name]) {
            fromEl.setAttribute(name, "");
        } else {
            fromEl.removeAttribute(name, "");
        }
    }
}

function forEachOption(el, fn, i) {
    var curChild = el.a_;

    while (curChild) {
        if (curChild.bC_ === "option") {
            fn(curChild, ++i);
        } else {
            i = forEachOption(curChild, fn, i);
        }

        curChild = curChild.b_;
    }

    return i;
}

// We use a JavaScript class to benefit from fast property lookup
function SpecialElHandlers() {}
SpecialElHandlers.prototype = {
    /**
     * Needed for IE. Apparently IE doesn't think that "selected" is an
     * attribute when reading over the attributes using selectEl.attributes
     */
    option: function (fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, "selected");
    },
    button: function (fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, "disabled");
    },
    /**
     * The "value" attribute is special for the <input> element since it sets
     * the initial value. Changing the "value" attribute without changing the
     * "value" property will have no effect since it is only used to the set the
     * initial value.  Similar for the "checked" attribute, and "disabled".
     */
    input: function (fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, "checked");
        syncBooleanAttrProp(fromEl, toEl, "disabled");

        if (fromEl.value != toEl.r_) {
            fromEl.value = toEl.r_;
        }

        if (fromEl.hasAttribute("value") && !toEl.bG_("value")) {
            fromEl.removeAttribute("value");
        }
    },

    textarea: function (fromEl, toEl) {
        var newValue = toEl.r_;
        if (fromEl.value != newValue) {
            fromEl.value = newValue;
        }

        var firstChild = fromEl.firstChild;
        if (firstChild) {
            // Needed for IE. Apparently IE sets the placeholder as the
            // node value and vise versa. This ignores an empty update.
            var oldValue = firstChild.nodeValue;

            if (oldValue == newValue || !newValue && oldValue == fromEl.placeholder) {
                return;
            }

            firstChild.nodeValue = newValue;
        }
    },
    select: function (fromEl, toEl) {
        if (!toEl.bG_("multiple")) {
            var selected = 0;
            forEachOption(toEl, function (option, i) {
                if (option.bG_("selected")) {
                    selected = i;
                }
            }, -1);

            if (fromEl.selectedIndex !== selected) {
                fromEl.selectedIndex = selected;
            }
        }
    }
};

module.exports = new SpecialElHandlers();
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/VNode", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
function VNode() {}

VNode.prototype = {
    bs_: function (finalChildCount) {
        this.bK_ = finalChildCount;
        this.bL_ = 0;
        this.bA_ = null;
        this.bM_ = null;
        this.bx_ = null;
        this.by_ = null;
    },

    aC_: null,

    get a_() {
        var firstChild = this.bA_;

        if (firstChild && firstChild.bz_) {
            var nestedFirstChild = firstChild.a_;
            // The first child is a DocumentFragment node.
            // If the DocumentFragment node has a first child then we will return that.
            // Otherwise, the DocumentFragment node is not *really* the first child and
            // we need to skip to its next sibling
            return nestedFirstChild || firstChild.b_;
        }

        return firstChild;
    },

    get b_() {
        var nextSibling = this.by_;

        if (nextSibling) {
            if (nextSibling.bz_) {
                var firstChild = nextSibling.a_;
                return firstChild || nextSibling.b_;
            }
        } else {
            var parentNode = this.bx_;
            if (parentNode && parentNode.bz_) {
                return parentNode.b_;
            }
        }

        return nextSibling;
    },

    bl_: function (child) {
        this.bL_++;

        if (this.bC_ === "textarea") {
            if (child.bN_) {
                var childValue = child.bt_;
                this.bD_ = (this.bD_ || "") + childValue;
            } else {
                throw TypeError();
            }
        } else {
            var lastChild = this.bM_;

            child.bx_ = this;

            if (lastChild) {
                lastChild.by_ = child;
            } else {
                this.bA_ = child;
            }

            this.bM_ = child;
        }

        return child;
    },

    bF_: function finishChild() {
        if (this.bL_ === this.bK_ && this.bx_) {
            return this.bx_.bF_();
        } else {
            return this;
        }
    }

    // ,toJSON: function() {
    //     var clone = Object.assign({
    //         nodeType: this.nodeType
    //     }, this);
    //
    //     for (var k in clone) {
    //         if (k.startsWith('_')) {
    //             delete clone[k];
    //         }
    //     }
    //     delete clone._nextSibling;
    //     delete clone._lastChild;
    //     delete clone.parentNode;
    //     return clone;
    // }
};

module.exports = VNode;
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/VComment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.18.10/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VComment(value) {
    this.bs_(-1 /* no children */);
    this.bt_ = value;
}

VComment.prototype = {
    bu_: 8,

    br_: function (doc) {
        var nodeValue = this.bt_;
        return doc.createComment(nodeValue);
    },

    __: function () {
        return new VComment(this.bt_);
    }
};

inherit(VComment, VNode);

module.exports = VComment;
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/VDocumentFragment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.18.10/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function VDocumentFragmentClone(other) {
    extend(this, other);
    this.bx_ = null;
    this.by_ = null;
}

function VDocumentFragment(out) {
    this.bs_(null /* childCount */);
    this.z_ = out;
}

VDocumentFragment.prototype = {
    bu_: 11,

    bz_: true,

    __: function () {
        return new VDocumentFragmentClone(this);
    },

    br_: function (doc) {
        return doc.createDocumentFragment();
    }
};

inherit(VDocumentFragment, VNode);

VDocumentFragmentClone.prototype = VDocumentFragment.prototype;

module.exports = VDocumentFragment;
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/VElement", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var domData = require('/marko$4.18.10/dist/runtime/components/dom-data'/*"../components/dom-data"*/);
var vElementByDOMNode = domData._Z_;
var VNode = require('/marko$4.18.10/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var ATTR_XLINK_HREF = "xlink:href";
var xmlnsRegExp = /^xmlns(:|$)/;
var NS_XLINK = "http://www.w3.org/1999/xlink";
var NS_HTML = "http://www.w3.org/1999/xhtml";
var NS_MATH = "http://www.w3.org/1998/Math/MathML";
var NS_SVG = "http://www.w3.org/2000/svg";
var DEFAULT_NS = {
    svg: NS_SVG,
    math: NS_MATH
};

var toString = String;

var FLAG_SIMPLE_ATTRS = 1;
// var FLAG_PRESERVE = 2;
var FLAG_CUSTOM_ELEMENT = 4;

var defineProperty = Object.defineProperty;

var ATTR_HREF = "href";
var EMPTY_OBJECT = Object.freeze({});

function convertAttrValue(type, value) {
    if (value === true) {
        return "";
    } else if (type == "object") {
        return JSON.stringify(value);
    } else {
        return toString(value);
    }
}

function assign(a, b) {
    for (var key in b) {
        if (b.hasOwnProperty(key)) {
            a[key] = b[key];
        }
    }
}

function setAttribute(el, namespaceURI, name, value) {
    if (namespaceURI === null) {
        el.setAttribute(name, value);
    } else {
        el.setAttributeNS(namespaceURI, name, value);
    }
}

function removeAttribute(el, namespaceURI, name) {
    if (namespaceURI === null) {
        el.removeAttribute(name);
    } else {
        el.removeAttributeNS(namespaceURI, name);
    }
}

function VElementClone(other) {
    this.bA_ = other.bA_;
    this.bx_ = null;
    this.by_ = null;

    this.bv_ = other.bv_;
    this.bB_ = other.bB_;
    this.aD_ = other.aD_;
    this.bC_ = other.bC_;
    this.g_ = other.g_;
    this.bD_ = other.bD_;
    this.bE_ = other.bE_;
}

function VElement(tagName, attrs, key, ownerComponent, childCount, flags, props) {
    this.bs_(childCount);

    var constId;

    if (props) {
        constId = props.i;
    }

    this.bv_ = key;
    this.g_ = flags || 0;
    this.aC_ = ownerComponent;
    this.bB_ = attrs || EMPTY_OBJECT;
    this.aD_ = props || EMPTY_OBJECT;
    this.bC_ = tagName;
    this.bD_ = null;
    this.bE_ = constId;
}

VElement.prototype = {
    bu_: 1,

    __: function () {
        return new VElementClone(this);
    },

    /**
     * Shorthand method for creating and appending an HTML element
     *
     * @param  {String} tagName    The tag name (e.g. "div")
     * @param  {int|null} attrCount  The number of attributes (or `null` if not known)
     * @param  {int|null} childCount The number of child nodes (or `null` if not known)
     */
    e: function (tagName, attrs, key, ownerComponent, childCount, flags, props) {
        var child = this.bl_(new VElement(tagName, attrs, key, ownerComponent, childCount, flags, props));

        if (childCount === 0) {
            return this.bF_();
        } else {
            return child;
        }
    },

    /**
     * Shorthand method for creating and appending a static node. The provided node is automatically cloned
     * using a shallow clone since it will be mutated as a result of setting `nextSibling` and `parentNode`.
     *
     * @param  {String} value The value for the new Comment node
     */
    n: function (node, ownerComponent) {
        node = node.__();
        node.aC_ = ownerComponent;
        this.bl_(node);
        return this.bF_();
    },

    br_: function (doc, parentNamespaceURI) {
        var tagName = this.bC_;
        var attributes = this.bB_;
        var namespaceURI = DEFAULT_NS[tagName] || parentNamespaceURI || NS_HTML;

        var flags = this.g_;
        var el = doc.createElementNS(namespaceURI, tagName);

        if (flags & FLAG_CUSTOM_ELEMENT) {
            assign(el, attributes);
        } else {
            for (var attrName in attributes) {
                var attrValue = attributes[attrName];

                if (attrValue !== false && attrValue != null) {
                    var type = typeof attrValue;

                    if (type !== "string") {
                        // Special attributes aren't copied to the real DOM. They are only
                        // kept in the virtual attributes map
                        attrValue = convertAttrValue(type, attrValue);
                    }

                    if (attrName == ATTR_XLINK_HREF) {
                        setAttribute(el, NS_XLINK, ATTR_HREF, attrValue);
                    } else {
                        el.setAttribute(attrName, attrValue);
                    }
                }
            }

            if (tagName === "textarea") {
                el.value = this.r_;
            }
        }

        vElementByDOMNode.set(el, this);

        return el;
    },

    bG_: function (name) {
        // We don't care about the namespaces since the there
        // is no chance that attributes with the same name will have
        // different namespaces
        var value = this.bB_[name];
        return value != null && value !== false;
    }
};

inherit(VElement, VNode);

var proto = VElementClone.prototype = VElement.prototype;

["checked", "selected", "disabled"].forEach(function (name) {
    defineProperty(proto, name, {
        get: function () {
            var value = this.bB_[name];
            return value !== false && value != null;
        }
    });
});

defineProperty(proto, "r_", {
    get: function () {
        var value = this.bD_;
        if (value == null) {
            value = this.bB_.value;
        }
        return value != null && value !== false ? toString(value) : this.bB_.type === "checkbox" || this.bB_.type === "radio" ? "on" : "";
    }
});

VElement.bH_ = function (attrs) {
    // By default this static method is a no-op, but if there are any
    // compiled components that have "no-update" attributes then
    // `preserve-attrs.js` will be imported and this method will be replaced
    // with a method that actually does something
    return attrs;
};

function virtualizeElement(node, virtualizeChildNodes) {
    var attributes = node.attributes;
    var attrCount = attributes.length;

    var attrs;

    if (attrCount) {
        attrs = {};
        for (var i = 0; i < attrCount; i++) {
            var attr = attributes[i];
            var attrName = attr.name;
            if (!xmlnsRegExp.test(attrName) && attrName !== "data-marko") {
                var attrNamespaceURI = attr.namespaceURI;
                if (attrNamespaceURI === NS_XLINK) {
                    attrs[ATTR_XLINK_HREF] = attr.value;
                } else {
                    attrs[attrName] = attr.value;
                }
            }
        }
    }

    var tagName = node.nodeName;

    if (node.namespaceURI === NS_HTML) {
        tagName = tagName.toLowerCase();
    }

    var vdomEl = new VElement(tagName, attrs, null /*key*/
    , null /*ownerComponent*/
    , 0 /*child count*/
    , 0 /*flags*/
    , null /*props*/
    );

    if (vdomEl.bC_ === "textarea") {
        vdomEl.bD_ = node.value;
    } else if (virtualizeChildNodes) {
        virtualizeChildNodes(node, vdomEl);
    }

    return vdomEl;
}

VElement.bI_ = virtualizeElement;

VElement.bJ_ = function (fromEl, vFromEl, toEl) {
    var removePreservedAttributes = VElement.bH_;

    var fromFlags = vFromEl.g_;
    var toFlags = toEl.g_;

    vElementByDOMNode.set(fromEl, toEl);

    var attrs = toEl.bB_;
    var props = toEl.aD_;

    if (toFlags & FLAG_CUSTOM_ELEMENT) {
        return assign(fromEl, attrs);
    }

    var attrName;

    // We use expando properties to associate the previous HTML
    // attributes provided as part of the VDOM node with the
    // real VElement DOM node. When diffing attributes,
    // we only use our internal representation of the attributes.
    // When diffing for the first time it's possible that the
    // real VElement node will not have the expando property
    // so we build the attribute map from the expando property

    var oldAttrs = vFromEl.bB_;

    if (oldAttrs) {
        if (oldAttrs === attrs) {
            // For constant attributes the same object will be provided
            // every render and we can use that to our advantage to
            // not waste time diffing a constant, immutable attribute
            // map.
            return;
        } else {
            oldAttrs = removePreservedAttributes(oldAttrs, props);
        }
    }

    var attrValue;

    if (toFlags & FLAG_SIMPLE_ATTRS && fromFlags & FLAG_SIMPLE_ATTRS) {
        if (oldAttrs["class"] !== (attrValue = attrs["class"])) {
            fromEl.className = attrValue;
        }
        if (oldAttrs.id !== (attrValue = attrs.id)) {
            fromEl.id = attrValue;
        }
        if (oldAttrs.style !== (attrValue = attrs.style)) {
            fromEl.style.cssText = attrValue;
        }
        return;
    }

    // In some cases we only want to set an attribute value for the first
    // render or we don't want certain attributes to be touched. To support
    // that use case we delete out all of the preserved attributes
    // so it's as if they never existed.
    attrs = removePreservedAttributes(attrs, props, true);

    var namespaceURI;

    // Loop over all of the attributes in the attribute map and compare
    // them to the value in the old map. However, if the value is
    // null/undefined/false then we want to remove the attribute
    for (attrName in attrs) {
        attrValue = attrs[attrName];
        namespaceURI = null;

        if (attrName === ATTR_XLINK_HREF) {
            namespaceURI = NS_XLINK;
            attrName = ATTR_HREF;
        }

        if (attrValue == null || attrValue === false) {
            removeAttribute(fromEl, namespaceURI, attrName);
        } else if (oldAttrs[attrName] !== attrValue) {
            var type = typeof attrValue;

            if (type !== "string") {
                attrValue = convertAttrValue(type, attrValue);
            }

            setAttribute(fromEl, namespaceURI, attrName, attrValue);
        }
    }

    // If there are any old attributes that are not in the new set of attributes
    // then we need to remove those attributes from the target node
    //
    // NOTE: We can skip this if the the element is keyed because if the element
    //       is keyed then we know we already processed all of the attributes for
    //       both the target and original element since target VElement nodes will
    //       have all attributes declared. However, we can only skip if the node
    //       was not a virtualized node (i.e., a node that was not rendered by a
    //       Marko template, but rather a node that was created from an HTML
    //       string or a real DOM node).
    if (toEl.bv_ === null) {
        for (attrName in oldAttrs) {
            if (!(attrName in attrs)) {
                if (attrName === ATTR_XLINK_HREF) {
                    fromEl.removeAttributeNS(ATTR_XLINK_HREF, ATTR_HREF);
                } else {
                    fromEl.removeAttribute(attrName);
                }
            }
        }
    }
};

module.exports = VElement;
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/VText", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.18.10/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VText(value) {
    this.bs_(-1 /* no children */);
    this.bt_ = value;
}

VText.prototype = {
    bN_: true,

    bu_: 3,

    br_: function (doc) {
        return doc.createTextNode(this.bt_);
    },

    __: function () {
        return new VText(this.bt_);
    }
};

inherit(VText, VNode);

module.exports = VText;
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/VComponent", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.18.10/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VComponent(component, key, ownerComponent, preserve) {
    this.bs_(null /* childCount */);
    this.bv_ = key;
    this.k_ = component;
    this.aC_ = ownerComponent;
    this.bw_ = preserve;
}

VComponent.prototype = {
    bu_: 2
};

inherit(VComponent, VNode);

module.exports = VComponent;
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/VFragment", function(require, exports, module, __filename, __dirname) { var domData = require('/marko$4.18.10/dist/runtime/components/dom-data'/*"../components/dom-data"*/);
var keysByDOMNode = domData.aa_;
var vElementByDOMNode = domData._Z_;
var VNode = require('/marko$4.18.10/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var createFragmentNode = require('/marko$4.18.10/dist/runtime/vdom/morphdom/fragment'/*"./morphdom/fragment"*/).ai_;

function VFragment(key, ownerComponent, preserve) {
    this.bs_(null /* childCount */);
    this.bv_ = key;
    this.aC_ = ownerComponent;
    this.bw_ = preserve;
}

VFragment.prototype = {
    bu_: 12,
    br_: function () {
        var fragment = createFragmentNode();
        keysByDOMNode.set(fragment, this.bv_);
        vElementByDOMNode.set(fragment, this);
        return fragment;
    }
};

inherit(VFragment, VNode);

module.exports = VFragment;
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/vdom", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.18.10/dist/runtime/vdom/VNode'/*"./VNode"*/);
var VComment = require('/marko$4.18.10/dist/runtime/vdom/VComment'/*"./VComment"*/);
var VDocumentFragment = require('/marko$4.18.10/dist/runtime/vdom/VDocumentFragment'/*"./VDocumentFragment"*/);
var VElement = require('/marko$4.18.10/dist/runtime/vdom/VElement'/*"./VElement"*/);
var VText = require('/marko$4.18.10/dist/runtime/vdom/VText'/*"./VText"*/);
var VComponent = require('/marko$4.18.10/dist/runtime/vdom/VComponent'/*"./VComponent"*/);
var VFragment = require('/marko$4.18.10/dist/runtime/vdom/VFragment'/*"./VFragment"*/);

var defaultDocument = typeof document != "undefined" && document;
var specialHtmlRegexp = /[&<]/;

function virtualizeChildNodes(node, vdomParent) {
    var curChild = node.firstChild;
    while (curChild) {
        vdomParent.bl_(virtualize(curChild));
        curChild = curChild.nextSibling;
    }
}

function virtualize(node) {
    switch (node.nodeType) {
        case 1:
            return VElement.bI_(node, virtualizeChildNodes);
        case 3:
            return new VText(node.nodeValue);
        case 8:
            return new VComment(node.nodeValue);
        case 11:
            var vdomDocFragment = new VDocumentFragment();
            virtualizeChildNodes(node, vdomDocFragment);
            return vdomDocFragment;
    }
}

function virtualizeHTML(html, doc) {
    if (!specialHtmlRegexp.test(html)) {
        return new VText(html);
    }

    var container = doc.createElement("body");
    container.innerHTML = html;
    var vdomFragment = new VDocumentFragment();

    var curChild = container.firstChild;
    while (curChild) {
        vdomFragment.bl_(virtualize(curChild));
        curChild = curChild.nextSibling;
    }

    return vdomFragment;
}

var Node_prototype = VNode.prototype;

/**
 * Shorthand method for creating and appending a Text node with a given value
 * @param  {String} value The text value for the new Text node
 */
Node_prototype.t = function (value) {
    var type = typeof value;
    var vdomNode;

    if (type !== "string") {
        if (value == null) {
            value = "";
        } else if (type === "object") {
            if (value.toHTML) {
                vdomNode = virtualizeHTML(value.toHTML(), document);
            }
        }
    }

    this.bl_(vdomNode || new VText(value.toString()));
    return this.bF_();
};

/**
 * Shorthand method for creating and appending a Comment node with a given value
 * @param  {String} value The value for the new Comment node
 */
Node_prototype.c = function (value) {
    this.bl_(new VComment(value));
    return this.bF_();
};

Node_prototype.bp_ = function () {
    return this.bl_(new VDocumentFragment());
};

exports.aV_ = VComment;
exports.aU_ = VDocumentFragment;
exports.aT_ = VElement;
exports.aW_ = VText;
exports.aX_ = VComponent;
exports.aY_ = VFragment;
exports.bI_ = virtualize;
exports.aZ_ = virtualizeHTML;
exports.b__ = defaultDocument;
});
$_mod.def("/marko$4.18.10/dist/runtime/vdom/morphdom/index", function(require, exports, module, __filename, __dirname) { "use strict";

var specialElHandlers = require('/marko$4.18.10/dist/runtime/vdom/morphdom/specialElHandlers'/*"./specialElHandlers"*/);
var componentsUtil = require('/marko$4.18.10/dist/runtime/components/util-browser'/*"../../components/util"*/);
var existingComponentLookup = componentsUtil.h_;
var destroyNodeRecursive = componentsUtil.F_;
var addComponentRootToKeyedElements = componentsUtil.aj_;
var normalizeComponentKey = componentsUtil.aF_;
var VElement = require('/marko$4.18.10/dist/runtime/vdom/vdom'/*"../vdom"*/).aT_;
var virtualizeElement = VElement.bI_;
var morphAttrs = VElement.bJ_;
var eventDelegation = require('/marko$4.18.10/dist/runtime/components/event-delegation'/*"../../components/event-delegation"*/);
var fragment = require('/marko$4.18.10/dist/runtime/vdom/morphdom/fragment'/*"./fragment"*/);
var helpers = require('/marko$4.18.10/dist/runtime/vdom/morphdom/helpers'/*"./helpers"*/);
var domData = require('/marko$4.18.10/dist/runtime/components/dom-data'/*"../../components/dom-data"*/);
var keysByDOMNode = domData.aa_;
var componentByDOMNode = domData.G_;
var vElementByDOMNode = domData._Z_;
var detachedByDOMNode = domData.a__;

var insertBefore = helpers.aH_;
var insertAfter = helpers.aI_;
var nextSibling = helpers.b_;
var firstChild = helpers.a_;
var removeChild = helpers.aJ_;
var createFragmentNode = fragment.ai_;
var beginFragmentNode = fragment.bP_;

var ELEMENT_NODE = 1;
var TEXT_NODE = 3;
var COMMENT_NODE = 8;
var COMPONENT_NODE = 2;
var FRAGMENT_NODE = 12;

// var FLAG_SIMPLE_ATTRS = 1;
var FLAG_PRESERVE = 2;
// var FLAG_CUSTOM_ELEMENT = 4;

function isAutoKey(key) {
    return !/^@/.test(key);
}

function compareNodeNames(fromEl, toEl) {
    return fromEl.bC_ === toEl.bC_;
}

function caseInsensitiveCompare(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}

function onNodeAdded(node, componentsContext) {
    if (node.nodeType === 1) {
        eventDelegation._X_(node, componentsContext);
    }
}

function morphdom(fromNode, toNode, doc, componentsContext) {
    var globalComponentsContext;
    var isHydrate = false;
    var keySequences = {};

    if (componentsContext) {
        globalComponentsContext = componentsContext.l_;
        isHydrate = globalComponentsContext._r_;
    }

    function insertVirtualNodeBefore(vNode, key, referenceEl, parentEl, ownerComponent, parentComponent) {
        var realNode = vNode.br_(doc, parentEl.namespaceURI);
        insertBefore(realNode, referenceEl, parentEl);

        if (vNode.bu_ === ELEMENT_NODE || vNode.bu_ === FRAGMENT_NODE) {
            if (key) {
                keysByDOMNode.set(realNode, key);
                (isAutoKey(key) ? parentComponent : ownerComponent).m_[key] = realNode;
            }

            morphChildren(realNode, vNode, parentComponent);
        }

        onNodeAdded(realNode, componentsContext);
    }

    function insertVirtualComponentBefore(vComponent, referenceNode, referenceNodeParentEl, component, key, ownerComponent, parentComponent) {
        var rootNode = component.K_ = insertBefore(createFragmentNode(), referenceNode, referenceNodeParentEl);
        componentByDOMNode.set(rootNode, component);

        if (key && ownerComponent) {
            key = normalizeComponentKey(key, parentComponent.id);
            addComponentRootToKeyedElements(ownerComponent.m_, key, rootNode, component.id);
            keysByDOMNode.set(rootNode, key);
        }

        morphComponent(component, vComponent);
    }

    function morphComponent(component, vComponent) {
        morphChildren(component.K_, vComponent, component);
    }

    var detachedNodes = [];

    function detachNode(node, parentNode, ownerComponent) {
        if (node.nodeType === ELEMENT_NODE || node.nodeType === FRAGMENT_NODE) {
            detachedNodes.push(node);
            detachedByDOMNode.set(node, ownerComponent || true);
        } else {
            destroyNodeRecursive(node);
            removeChild(node);
        }
    }

    function destroyComponent(component) {
        component.destroy();
    }

    function morphChildren(fromNode, toNode, parentComponent) {
        var curFromNodeChild = firstChild(fromNode);
        var curToNodeChild = toNode.a_;

        var curToNodeKey;
        var curFromNodeKey;
        var curToNodeType;

        var fromNextSibling;
        var toNextSibling;
        var matchingFromEl;
        var matchingFromComponent;
        var curVFromNodeChild;
        var fromComponent;

        outer: while (curToNodeChild) {
            toNextSibling = curToNodeChild.b_;
            curToNodeType = curToNodeChild.bu_;
            curToNodeKey = curToNodeChild.bv_;

            var ownerComponent = curToNodeChild.aC_ || parentComponent;
            var referenceComponent;

            if (curToNodeType === COMPONENT_NODE) {
                var component = curToNodeChild.k_;
                if ((matchingFromComponent = existingComponentLookup[component.id]) === undefined) {
                    if (isHydrate === true) {
                        var rootNode = beginFragmentNode(curFromNodeChild, fromNode);
                        component.K_ = rootNode;
                        componentByDOMNode.set(rootNode, component);

                        if (ownerComponent && curToNodeKey) {
                            curToNodeKey = normalizeComponentKey(curToNodeKey, parentComponent.id);
                            addComponentRootToKeyedElements(ownerComponent.m_, curToNodeKey, rootNode, component.id);

                            keysByDOMNode.set(rootNode, curToNodeKey);
                        }

                        morphComponent(component, curToNodeChild);

                        curFromNodeChild = nextSibling(rootNode);
                    } else {
                        insertVirtualComponentBefore(curToNodeChild, curFromNodeChild, fromNode, component, curToNodeKey, ownerComponent, parentComponent);
                    }
                } else {
                    if (matchingFromComponent.K_ !== curFromNodeChild) {
                        if (curFromNodeChild && (fromComponent = componentByDOMNode.get(curFromNodeChild)) && globalComponentsContext.q_[fromComponent.id] === undefined) {
                            // The component associated with the current real DOM node was not rendered
                            // so we should just remove it out of the real DOM by destroying it
                            curFromNodeChild = nextSibling(fromComponent.K_);
                            destroyComponent(fromComponent);
                            continue;
                        }

                        // We need to move the existing component into
                        // the correct location
                        insertBefore(matchingFromComponent.K_, curFromNodeChild, fromNode);
                    } else {
                        curFromNodeChild = curFromNodeChild && nextSibling(curFromNodeChild);
                    }

                    if (!curToNodeChild.bw_) {
                        morphComponent(component, curToNodeChild);
                    }
                }

                curToNodeChild = toNextSibling;
                continue;
            } else if (curToNodeKey) {
                curVFromNodeChild = undefined;
                curFromNodeKey = undefined;
                var curToNodeKeyOriginal = curToNodeKey;

                if (isAutoKey(curToNodeKey)) {
                    if (ownerComponent !== parentComponent) {
                        curToNodeKey += ":" + ownerComponent.id;
                    }
                    referenceComponent = parentComponent;
                } else {
                    referenceComponent = ownerComponent;
                }

                var keySequence = keySequences[referenceComponent.id] || (keySequences[referenceComponent.id] = globalComponentsContext._P_());

                // We have a keyed element. This is the fast path for matching
                // up elements
                curToNodeKey = keySequence.c_(curToNodeKey);

                if (curFromNodeChild) {
                    curFromNodeKey = keysByDOMNode.get(curFromNodeChild);
                    curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);
                    fromNextSibling = nextSibling(curFromNodeChild);
                }

                if (curFromNodeKey === curToNodeKey) {
                    // Elements line up. Now we just have to make sure they are compatible
                    if ((curToNodeChild.g_ & FLAG_PRESERVE) === 0 && !curToNodeChild.bw_) {
                        // We just skip over the fromNode if it is preserved

                        if (compareNodeNames(curToNodeChild, curVFromNodeChild)) {
                            morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
                        } else {
                            // Remove the old node
                            detachNode(curFromNodeChild, fromNode, ownerComponent);

                            // Incompatible nodes. Just move the target VNode into the DOM at this position
                            insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);
                        }
                    } else {
                        // this should be preserved.
                    }
                } else {
                    if ((matchingFromEl = referenceComponent.m_[curToNodeKey]) === undefined) {
                        if (isHydrate === true && curFromNodeChild) {
                            if (curFromNodeChild.nodeType === ELEMENT_NODE && caseInsensitiveCompare(curFromNodeChild.nodeName, curToNodeChild.bC_ || "")) {
                                curVFromNodeChild = virtualizeElement(curFromNodeChild);
                                curVFromNodeChild.bC_ = curToNodeChild.bC_;
                                keysByDOMNode.set(curFromNodeChild, curToNodeKey);
                                morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
                                curToNodeChild = toNextSibling;
                                curFromNodeChild = fromNextSibling;
                                continue;
                            } else if (curToNodeChild.bu_ === FRAGMENT_NODE && curFromNodeChild.nodeType === COMMENT_NODE) {
                                var content = curFromNodeChild.nodeValue;
                                if (content == "F#" + curToNodeKeyOriginal) {
                                    var endNode = curFromNodeChild.nextSibling;
                                    var depth = 0;
                                    var nodeValue;

                                    // eslint-disable-next-line no-constant-condition
                                    while (true) {
                                        if (endNode.nodeType === COMMENT_NODE) {
                                            nodeValue = endNode.nodeValue;
                                            if (nodeValue === "F/") {
                                                if (depth === 0) {
                                                    break;
                                                } else {
                                                    depth--;
                                                }
                                            } else if (nodeValue.indexOf("F#") === 0) {
                                                depth++;
                                            }
                                        }
                                        endNode = endNode.nextSibling;
                                    }

                                    var fragment = createFragmentNode(curFromNodeChild, endNode.nextSibling, fromNode);
                                    keysByDOMNode.set(fragment, curToNodeKey);
                                    vElementByDOMNode.set(fragment, curToNodeChild);
                                    referenceComponent.m_[curToNodeKey] = fragment;
                                    removeChild(curFromNodeChild);
                                    removeChild(endNode);

                                    if (!curToNodeChild.bw_) {
                                        morphChildren(fragment, curToNodeChild, parentComponent);
                                    }

                                    curToNodeChild = toNextSibling;
                                    curFromNodeChild = fragment.nextSibling;
                                    continue;
                                }
                            }
                        }

                        insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);
                        fromNextSibling = curFromNodeChild;
                    } else {
                        if (detachedByDOMNode.get(matchingFromEl) !== undefined) {
                            detachedByDOMNode.set(matchingFromEl, undefined);
                        }

                        if ((curToNodeChild.g_ & FLAG_PRESERVE) === 0 && !curToNodeChild.bw_) {
                            curVFromNodeChild = vElementByDOMNode.get(matchingFromEl);

                            if (compareNodeNames(curVFromNodeChild, curToNodeChild)) {
                                if (fromNextSibling === matchingFromEl) {
                                    // Single element removal:
                                    // A <-> A
                                    // B <-> C <-- We are here
                                    // C     D
                                    // D
                                    //
                                    // Single element swap:
                                    // A <-> A
                                    // B <-> C <-- We are here
                                    // C     B

                                    if (toNextSibling && toNextSibling.bv_ === curFromNodeKey) {
                                        // Single element swap

                                        // We want to stay on the current real DOM node
                                        fromNextSibling = curFromNodeChild;

                                        // But move the matching element into place
                                        insertBefore(matchingFromEl, curFromNodeChild, fromNode);
                                    } else {
                                        // Single element removal

                                        // We need to remove the current real DOM node
                                        // and the matching real DOM node will fall into
                                        // place. We will continue diffing with next sibling
                                        // after the real DOM node that just fell into place
                                        fromNextSibling = nextSibling(fromNextSibling);

                                        if (curFromNodeChild) {
                                            detachNode(curFromNodeChild, fromNode, ownerComponent);
                                        }
                                    }
                                } else {
                                    // A <-> A
                                    // B <-> D <-- We are here
                                    // C
                                    // D

                                    // We need to move the matching node into place
                                    insertAfter(matchingFromEl, curFromNodeChild, fromNode);

                                    if (curFromNodeChild) {
                                        detachNode(curFromNodeChild, fromNode, ownerComponent);
                                    }
                                }

                                if ((curToNodeChild.g_ & FLAG_PRESERVE) === 0) {
                                    morphEl(matchingFromEl, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
                                }
                            } else {
                                insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);
                                detachNode(matchingFromEl, fromNode, ownerComponent);
                            }
                        } else {
                            // preserve the node
                            // but still we need to diff the current from node
                            insertBefore(matchingFromEl, curFromNodeChild, fromNode);
                            fromNextSibling = curFromNodeChild;
                        }
                    }
                }

                curToNodeChild = toNextSibling;
                curFromNodeChild = fromNextSibling;
                continue;
            }

            // The know the target node is not a VComponent node and we know
            // it is also not a preserve node. Let's now match up the HTML
            // element, text node, comment, etc.
            while (curFromNodeChild) {
                fromNextSibling = nextSibling(curFromNodeChild);

                if (fromComponent = componentByDOMNode.get(curFromNodeChild)) {
                    // The current "to" element is not associated with a component,
                    // but the current "from" element is associated with a component

                    // Even if we destroy the current component in the original
                    // DOM or not, we still need to skip over it since it is
                    // not compatible with the current "to" node
                    curFromNodeChild = fromNextSibling;

                    if (!globalComponentsContext.q_[fromComponent.id]) {
                        destroyComponent(fromComponent);
                    }

                    continue; // Move to the next "from" node
                }

                var curFromNodeType = curFromNodeChild.nodeType;

                var isCompatible = undefined;

                if (curFromNodeType === curToNodeType) {
                    if (curFromNodeType === ELEMENT_NODE) {
                        // Both nodes being compared are Element nodes
                        curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);
                        if (curVFromNodeChild === undefined) {
                            if (isHydrate === true) {
                                curVFromNodeChild = virtualizeElement(curFromNodeChild);

                                if (caseInsensitiveCompare(curVFromNodeChild.bC_, curToNodeChild.bC_)) {
                                    curVFromNodeChild.bC_ = curToNodeChild.bC_;
                                }
                            } else {
                                // Skip over nodes that don't look like ours...
                                curFromNodeChild = fromNextSibling;
                                continue;
                            }
                        } else if (curFromNodeKey = curVFromNodeChild.bv_) {
                            // We have a keyed element here but our target VDOM node
                            // is not keyed so this not doesn't belong
                            isCompatible = false;
                        }

                        isCompatible = isCompatible !== false && compareNodeNames(curVFromNodeChild, curToNodeChild) === true;

                        if (isCompatible === true) {
                            // We found compatible DOM elements so transform
                            // the current "from" node to match the current
                            // target DOM node.
                            morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
                        }
                    } else if (curFromNodeType === TEXT_NODE || curFromNodeType === COMMENT_NODE) {
                        // Both nodes being compared are Text or Comment nodes
                        isCompatible = true;
                        // Simply update nodeValue on the original node to
                        // change the text value
                        if (curFromNodeChild.nodeValue !== curToNodeChild.bt_) {
                            curFromNodeChild.nodeValue = curToNodeChild.bt_;
                        }
                    }
                }

                if (isCompatible === true) {
                    // Advance both the "to" child and the "from" child since we found a match
                    curToNodeChild = toNextSibling;
                    curFromNodeChild = fromNextSibling;
                    continue outer;
                }

                if (curFromNodeKey) {
                    if (globalComponentsContext.o_[parentComponent.id + "-" + curFromNodeKey] === undefined) {
                        detachNode(curFromNodeChild, fromNode, ownerComponent);
                    }
                } else {
                    detachNode(curFromNodeChild, fromNode, ownerComponent);
                }

                curFromNodeChild = fromNextSibling;
            } // END: while (curFromNodeChild)

            // If we got this far then we did not find a candidate match for
            // our "to node" and we exhausted all of the children "from"
            // nodes. Therefore, we will just append the current "to" node
            // to the end
            insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);

            curToNodeChild = toNextSibling;
            curFromNodeChild = fromNextSibling;
        }

        // We have processed all of the "to nodes".
        if (fromNode.bO_) {
            // If we are in an unfinished fragment, we have reached the end of the nodes
            // we were matching up and need to end the fragment
            fromNode.bO_(curFromNodeChild);
        } else {
            // If curFromNodeChild is non-null then we still have some from nodes
            // left over that need to be removed
            var fragmentBoundary = fromNode.nodeType === FRAGMENT_NODE ? fromNode.endNode : null;

            while (curFromNodeChild && curFromNodeChild !== fragmentBoundary) {
                fromNextSibling = nextSibling(curFromNodeChild);

                if (fromComponent = componentByDOMNode.get(curFromNodeChild)) {
                    curFromNodeChild = fromNextSibling;
                    if (!globalComponentsContext.q_[fromComponent.id]) {
                        destroyComponent(fromComponent);
                    }
                    continue;
                }

                curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);

                // For transcluded content, we need to check if the element belongs to a different component
                // context than the current component and ensure it gets removed from its key index.
                if (isAutoKey(keysByDOMNode.get(fromNode))) {
                    referenceComponent = parentComponent;
                } else {
                    referenceComponent = curVFromNodeChild && curVFromNodeChild.aC_;
                }

                detachNode(curFromNodeChild, fromNode, referenceComponent);

                curFromNodeChild = fromNextSibling;
            }
        }
    }

    function morphEl(fromEl, vFromEl, toEl, toElKey, ownerComponent, parentComponent) {
        var nodeName = toEl.bC_;

        if (isHydrate === true && toElKey) {
            ownerComponent.m_[toElKey] = fromEl;
        }

        var constId = toEl.bE_;
        if (constId !== undefined && vFromEl.bE_ === constId) {
            return;
        }

        morphAttrs(fromEl, vFromEl, toEl);

        if (toElKey && globalComponentsContext.n_[parentComponent.id + "-" + toElKey] === true) {
            // Don't morph the children since they are preserved
            return;
        }

        if (nodeName !== "textarea") {
            morphChildren(fromEl, toEl, parentComponent);
        }

        var specialElHandler = specialElHandlers[nodeName];
        if (specialElHandler !== undefined) {
            specialElHandler(fromEl, toEl);
        }
    } // END: morphEl(...)

    morphChildren(fromNode, toNode, toNode.k_);

    detachedNodes.forEach(function (node) {
        var detachedFromComponent = detachedByDOMNode.get(node);

        if (detachedFromComponent !== undefined) {
            detachedByDOMNode.set(node, undefined);

            var componentToDestroy = componentByDOMNode.get(node);
            if (componentToDestroy) {
                componentToDestroy.destroy();
            } else if (node.parentNode) {
                destroyNodeRecursive(node, detachedFromComponent !== true && detachedFromComponent);

                if (eventDelegation._a_(node) != false) {
                    removeChild(node);
                }
            }
        }
    });
}

module.exports = morphdom;
});
$_mod.def("/marko$4.18.10/dist/runtime/components/Component", function(require, exports, module, __filename, __dirname) { "use strict";
/* jshint newcap:false */

var complain;

var domInsert = require('/marko$4.18.10/dist/runtime/dom-insert'/*"../dom-insert"*/);
var defaultCreateOut = require('/marko$4.18.10/dist/runtime/createOut'/*"../createOut"*/);
var getComponentsContext = require('/marko$4.18.10/dist/runtime/components/ComponentsContext'/*"./ComponentsContext"*/).D_;
var componentsUtil = require('/marko$4.18.10/dist/runtime/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.h_;
var emitLifecycleEvent = componentsUtil.E_;
var destroyNodeRecursive = componentsUtil.F_;
var EventEmitter = require('/events-light$1.0.5/src/index'/*"events-light"*/);
var RenderResult = require('/marko$4.18.10/dist/runtime/RenderResult'/*"../RenderResult"*/);
var SubscriptionTracker = require('/listener-tracker$2.0.0/lib/listener-tracker'/*"listener-tracker"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var updateManager = require('/marko$4.18.10/dist/runtime/components/update-manager'/*"./update-manager"*/);
var morphdom = require('/marko$4.18.10/dist/runtime/vdom/morphdom/index'/*"../vdom/morphdom"*/);
var eventDelegation = require('/marko$4.18.10/dist/runtime/components/event-delegation'/*"./event-delegation"*/);
var domData = require('/marko$4.18.10/dist/runtime/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.G_;
var CONTEXT_KEY = "__subtree_context__";

var slice = Array.prototype.slice;

var COMPONENT_SUBSCRIBE_TO_OPTIONS;
var NON_COMPONENT_SUBSCRIBE_TO_OPTIONS = {
    addDestroyListener: false
};

var emit = EventEmitter.prototype.emit;
var ELEMENT_NODE = 1;

function removeListener(removeEventListenerHandle) {
    removeEventListenerHandle();
}

function walkFragments(fragment) {
    var node;

    while (fragment) {
        node = fragment.firstChild;

        if (!node) {
            break;
        }

        fragment = node.fragment;
    }

    return node;
}

function handleCustomEventWithMethodListener(component, targetMethodName, args, extraArgs) {
    // Remove the "eventType" argument
    args.push(component);

    if (extraArgs) {
        args = extraArgs.concat(args);
    }

    var targetComponent = componentLookup[component.H_];
    var targetMethod = typeof targetMethodName === "function" ? targetMethodName : targetComponent[targetMethodName];
    if (!targetMethod) {
        throw Error("Method not found: " + targetMethodName);
    }

    targetMethod.apply(targetComponent, args);
}

function resolveKeyHelper(key, index) {
    return index ? key + "_" + index : key;
}

function resolveComponentIdHelper(component, key, index) {
    return component.id + "-" + resolveKeyHelper(key, index);
}

/**
 * This method is used to process "update_<stateName>" handler functions.
 * If all of the modified state properties have a user provided update handler
 * then a rerender will be bypassed and, instead, the DOM will be updated
 * looping over and invoking the custom update handlers.
 * @return {boolean} Returns true if if the DOM was updated. False, otherwise.
 */
function processUpdateHandlers(component, stateChanges, oldState) {
    var handlerMethod;
    var handlers;

    for (var propName in stateChanges) {
        if (stateChanges.hasOwnProperty(propName)) {
            var handlerMethodName = "update_" + propName;

            handlerMethod = component[handlerMethodName];
            if (handlerMethod) {
                (handlers || (handlers = [])).push([propName, handlerMethod]);
            } else {
                // This state change does not have a state handler so return false
                // to force a rerender
                return;
            }
        }
    }

    // If we got here then all of the changed state properties have
    // an update handler or there are no state properties that actually
    // changed.
    if (handlers) {
        // Otherwise, there are handlers for all of the changed properties
        // so apply the updates using those handlers

        handlers.forEach(function (handler) {
            var propertyName = handler[0];
            handlerMethod = handler[1];

            var newValue = stateChanges[propertyName];
            var oldValue = oldState[propertyName];
            handlerMethod.call(component, newValue, oldValue);
        });

        emitLifecycleEvent(component, "update");

        component.I_();
    }

    return true;
}

function checkInputChanged(existingComponent, oldInput, newInput) {
    if (oldInput != newInput) {
        if (oldInput == null || newInput == null) {
            return true;
        }

        var oldKeys = Object.keys(oldInput);
        var newKeys = Object.keys(newInput);
        var len = oldKeys.length;
        if (len !== newKeys.length) {
            return true;
        }

        for (var i = 0; i < len; i++) {
            var key = oldKeys[i];
            if (oldInput[key] !== newInput[key]) {
                return true;
            }
        }
    }

    return false;
}

var componentProto;

/**
 * Base component type.
 *
 * NOTE: Any methods that are prefixed with an underscore should be considered private!
 */
function Component(id) {
    EventEmitter.call(this);
    this.id = id;
    this.J_ = null;
    this.K_ = null;
    this.L_ = null;
    this.M_ = null;
    this.N_ = null; // Used to keep track of bubbling DOM events for components rendered on the server
    this.O_ = null;
    this.H_ = null;
    this.P_ = null;
    this.Q_ = undefined;
    this.R_ = false;
    this.S_ = undefined;

    this.T_ = false;
    this.U_ = false;
    this.V_ = false;
    this.W_ = false;

    this.X_ = undefined;

    this.m_ = {};
    this.Y_ = undefined;
}

Component.prototype = componentProto = {
    Z_: true,

    subscribeTo: function (target) {
        if (!target) {
            throw TypeError();
        }

        var subscriptions = this.L_ || (this.L_ = new SubscriptionTracker());

        var subscribeToOptions = target.Z_ ? COMPONENT_SUBSCRIBE_TO_OPTIONS : NON_COMPONENT_SUBSCRIBE_TO_OPTIONS;

        return subscriptions.subscribeTo(target, subscribeToOptions);
    },

    emit: function (eventType) {
        var customEvents = this.O_;
        var target;

        if (customEvents && (target = customEvents[eventType])) {
            var targetMethodName = target[0];
            var isOnce = target[1];
            var extraArgs = target[2];
            var args = slice.call(arguments, 1);

            handleCustomEventWithMethodListener(this, targetMethodName, args, extraArgs);

            if (isOnce) {
                delete customEvents[eventType];
            }
        }

        if (this.listenerCount(eventType)) {
            return emit.apply(this, arguments);
        }
    },
    getElId: function (key, index) {
        return resolveComponentIdHelper(this, key, index);
    },
    getEl: function (key, index) {
        if (key) {
            var resolvedKey = resolveKeyHelper(key, index);
            var keyedElement = this.m_["@" + resolvedKey];

            if (!keyedElement) {
                var keyedComponent = this.getComponent(resolvedKey);

                if (keyedComponent) {

                    return walkFragments(keyedComponent.K_);
                    // eslint-disable-next-line no-constant-condition
                }
            }

            return keyedElement;
        } else {
            return this.el;
        }
    },
    getEls: function (key) {
        key = key + "[]";

        var els = [];
        var i = 0;
        var el;
        while (el = this.getEl(key, i)) {
            els.push(el);
            i++;
        }
        return els;
    },
    getComponent: function (key, index) {
        var rootNode = this.m_[resolveKeyHelper(key, index)];
        if (/\[\]$/.test(key)) {
            rootNode = rootNode && rootNode[Object.keys(rootNode)[0]];
            // eslint-disable-next-line no-constant-condition
        }
        return rootNode && componentsByDOMNode.get(rootNode);
    },
    getComponents: function (key) {
        var lookup = this.m_[key + "[]"];
        return lookup ? Object.keys(lookup).map(function (key) {
            return componentsByDOMNode.get(lookup[key]);
        }).filter(Boolean) : [];
    },
    destroy: function () {
        if (this.T_) {
            return;
        }

        var root = this.K_;

        this.___();

        var nodes = root.nodes;

        nodes.forEach(function (node) {
            destroyNodeRecursive(node);

            if (eventDelegation._a_(node) !== false) {
                node.parentNode.removeChild(node);
            }
        });

        root.detached = true;

        delete componentLookup[this.id];
        this.m_ = {};
    },

    ___: function () {
        if (this.T_) {
            return;
        }

        emitLifecycleEvent(this, "destroy");
        this.T_ = true;

        componentsByDOMNode.set(this.K_, undefined);

        this.K_ = null;

        // Unsubscribe from all DOM events
        this._b_();

        var subscriptions = this.L_;
        if (subscriptions) {
            subscriptions.removeAllListeners();
            this.L_ = null;
        }
    },

    isDestroyed: function () {
        return this.T_;
    },
    get state() {
        return this.J_;
    },
    set state(newState) {
        var state = this.J_;
        if (!state && !newState) {
            return;
        }

        if (!state) {
            state = this.J_ = new this._c_(this);
        }

        state._d_(newState || {});

        if (state.V_) {
            this._e_();
        }

        if (!newState) {
            this.J_ = null;
        }
    },
    setState: function (name, value) {
        var state = this.J_;

        if (typeof name == "object") {
            // Merge in the new state with the old state
            var newState = name;
            for (var k in newState) {
                if (newState.hasOwnProperty(k)) {
                    state._f_(k, newState[k], true /* ensure:true */);
                }
            }
        } else {
            state._f_(name, value, true /* ensure:true */);
        }
    },

    setStateDirty: function (name, value) {
        var state = this.J_;

        if (arguments.length == 1) {
            value = state[name];
        }

        state._f_(name, value, true /* ensure:true */
        , true /* forceDirty:true */
        );
    },

    replaceState: function (newState) {
        this.J_._d_(newState);
    },

    get input() {
        return this.Q_;
    },
    set input(newInput) {
        if (this.W_) {
            this.Q_ = newInput;
        } else {
            this._g_(newInput);
        }
    },

    _g_: function (newInput, onInput, out) {
        onInput = onInput || this.onInput;
        var updatedInput;

        var oldInput = this.Q_;
        this.Q_ = undefined;
        this._h_ = out && out[CONTEXT_KEY] || this._h_;

        if (onInput) {
            // We need to set a flag to preview `this.input = foo` inside
            // onInput causing infinite recursion
            this.W_ = true;
            updatedInput = onInput.call(this, newInput || {}, out);
            this.W_ = false;
        }

        newInput = this.P_ = updatedInput || newInput;

        if (this.V_ = checkInputChanged(this, oldInput, newInput)) {
            this._e_();
        }

        if (this.Q_ === undefined) {
            this.Q_ = newInput;
            if (newInput && newInput.$global) {
                this.S_ = newInput.$global;
            }
        }

        return newInput;
    },

    forceUpdate: function () {
        this.V_ = true;
        this._e_();
    },

    _e_: function () {
        if (!this.U_) {
            this.U_ = true;
            updateManager._i_(this);
        }
    },

    update: function () {
        if (this.T_ === true || this._j_ === false) {
            return;
        }

        var input = this.Q_;
        var state = this.J_;

        if (this.V_ === false && state !== null && state.V_ === true) {
            if (processUpdateHandlers(this, state._k_, state._l_, state)) {
                state.V_ = false;
            }
        }

        if (this._j_ === true) {
            // The UI component is still dirty after process state handlers
            // then we should rerender

            if (this.shouldUpdate(input, state) !== false) {
                this._m_();
            }
        }

        this.I_();
    },

    get _j_() {
        return this.V_ === true || this.J_ !== null && this.J_.V_ === true;
    },

    I_: function () {
        this.V_ = false;
        this.U_ = false;
        this.P_ = null;
        var state = this.J_;
        if (state) {
            state.I_();
        }
    },

    shouldUpdate: function () {
        return true;
    },

    E_: function (eventType, eventArg1, eventArg2) {
        emitLifecycleEvent(this, eventType, eventArg1, eventArg2);
    },

    _m_: function () {
        var self = this;
        var renderer = self._n_;

        if (!renderer) {
            throw TypeError();
        }

        var input = this.P_ || this.Q_;

        updateManager._o_(function () {
            self._p_(input, false).afterInsert(self.X_);
        });

        this.I_();
    },

    _p_: function (input, isHydrate) {
        var doc = this.X_;
        var globalData = this.S_;
        var rootNode = this.K_;
        var renderer = this._n_;
        var createOut = renderer.createOut || defaultCreateOut;
        var out = createOut(globalData);
        out.sync();
        out.X_ = this.X_;
        out[CONTEXT_KEY] = this._h_;

        var componentsContext = getComponentsContext(out);
        var globalComponentsContext = componentsContext.l_;
        globalComponentsContext._q_ = this;
        globalComponentsContext._r_ = isHydrate;

        renderer(input, out);

        var result = new RenderResult(out);

        var targetNode = out.C_().a_;

        morphdom(rootNode, targetNode, doc, componentsContext);

        return result;
    },

    _s_: function () {
        var root = this.K_;
        root.remove();
        return root;
    },

    _b_: function () {
        var eventListenerHandles = this.M_;
        if (eventListenerHandles) {
            eventListenerHandles.forEach(removeListener);
            this.M_ = null;
        }
    },

    get _t_() {
        var state = this.J_;
        return state && state._u_;
    },

    _v_: function (customEvents, scope) {
        var finalCustomEvents = this.O_ = {};
        this.H_ = scope;

        customEvents.forEach(function (customEvent) {
            var eventType = customEvent[0];
            var targetMethodName = customEvent[1];
            var isOnce = customEvent[2];
            var extraArgs = customEvent[3];

            finalCustomEvents[eventType] = [targetMethodName, isOnce, extraArgs];
        });
    },

    get el() {
        return walkFragments(this.K_);
    },

    get els() {
        return (this.K_ ? this.K_.nodes : []).filter(function (el) {
            return el.nodeType === ELEMENT_NODE;
        });
        // eslint-disable-next-line no-constant-condition
    }
};

componentProto.elId = componentProto.getElId;
componentProto._w_ = componentProto.update;
componentProto._x_ = componentProto.destroy;

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(componentProto, function getEl(component) {
    return component._s_();
}, function afterInsert(component) {
    return component;
});

inherit(Component, EventEmitter);

module.exports = Component;
});
$_mod.def("/marko$4.18.10/dist/runtime/components/defineComponent", function(require, exports, module, __filename, __dirname) { "use strict";
/* jshint newcap:false */

var BaseState = require('/marko$4.18.10/dist/runtime/components/State'/*"./State"*/);
var BaseComponent = require('/marko$4.18.10/dist/runtime/components/Component'/*"./Component"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

module.exports = function defineComponent(def, renderer) {
    if (def.Z_) {
        return def;
    }

    var ComponentClass = function () {};
    var proto;

    var type = typeof def;

    if (type == "function") {
        proto = def.prototype;
    } else if (type == "object") {
        proto = def;
    } else {
        throw TypeError();
    }

    ComponentClass.prototype = proto;

    // We don't use the constructor provided by the user
    // since we don't invoke their constructor until
    // we have had a chance to do our own initialization.
    // Instead, we store their constructor in the "initComponent"
    // property and that method gets called later inside
    // init-components-browser.js
    function Component(id) {
        BaseComponent.call(this, id);
    }

    if (!proto.Z_) {
        // Inherit from Component if they didn't already
        inherit(ComponentClass, BaseComponent);
    }

    // The same prototype will be used by our constructor after
    // we he have set up the prototype chain using the inherit function
    proto = Component.prototype = ComponentClass.prototype;

    // proto.constructor = def.constructor = Component;

    // Set a flag on the constructor function to make it clear this is
    // a component so that we can short-circuit this work later
    Component.Z_ = true;

    function State(component) {
        BaseState.call(this, component);
    }
    inherit(State, BaseState);
    proto._c_ = State;
    proto._n_ = renderer;

    return Component;
};
});
$_mod.main("/marko$4.18.10/dist/loader", "");
$_mod.remap("/marko$4.18.10/dist/loader/index", "/marko$4.18.10/dist/loader/index-browser");
$_mod.remap("/marko$4.18.10/dist/loader/index-browser", "/marko$4.18.10/dist/loader/index-browser-dynamic");
$_mod.def("/marko$4.18.10/dist/loader/index-browser-dynamic", function(require, exports, module, __filename, __dirname) { "use strict";

module.exports = function load(templatePath) {
    // We make the assumption that the template path is a
    // fully resolved module path and that the module exists
    // as a CommonJS module
    return require(templatePath);
};
});
$_mod.def("/marko$4.18.10/dist/runtime/components/registry-browser", function(require, exports, module, __filename, __dirname) { var complain;
var defineComponent = require('/marko$4.18.10/dist/runtime/components/defineComponent'/*"./defineComponent"*/);
var loader = require('/marko$4.18.10/dist/loader/index-browser-dynamic'/*"../../loader"*/);

var registered = {};
var loaded = {};
var componentTypes = {};

function register(componentId, def) {
    registered[componentId] = def;
    delete loaded[componentId];
    delete componentTypes[componentId];
    return componentId;
}

function load(typeName, isLegacy) {
    var target = loaded[typeName];
    if (!target) {
        target = registered[typeName];

        if (target) {
            target = target();
        } else if (isLegacy) {
            target = window.$markoLegacy.load(typeName);
        } else {
            target = loader(typeName);
            // eslint-disable-next-line no-constant-condition
        }

        if (!target) {
            throw Error("Component not found: " + typeName);
        }

        loaded[typeName] = target;
    }

    return target;
}

function getComponentClass(typeName, isLegacy) {
    var ComponentClass = componentTypes[typeName];

    if (ComponentClass) {
        return ComponentClass;
    }

    ComponentClass = load(typeName, isLegacy);

    ComponentClass = ComponentClass.Component || ComponentClass;

    if (!ComponentClass.Z_) {
        ComponentClass = defineComponent(ComponentClass, ComponentClass.renderer);
    }

    // Make the component "type" accessible on each component instance
    ComponentClass.prototype.f_ = typeName;

    // eslint-disable-next-line no-constant-condition


    componentTypes[typeName] = ComponentClass;

    return ComponentClass;
}

function createComponent(typeName, id, isLegacy) {
    var ComponentClass = getComponentClass(typeName, isLegacy);
    return new ComponentClass(id);
}

exports.ae_ = register;
exports._J_ = createComponent;
});
$_mod.def("/marko$4.18.10/dist/runtime/components/init-components-browser", function(require, exports, module, __filename, __dirname) { "use strict";

var warp10Finalize = require('/warp10$2.0.1/finalize'/*"warp10/finalize"*/);
var eventDelegation = require('/marko$4.18.10/dist/runtime/components/event-delegation'/*"./event-delegation"*/);
var win = window;
var defaultDocument = document;
var createFragmentNode = require('/marko$4.18.10/dist/runtime/vdom/morphdom/fragment'/*"../vdom/morphdom/fragment"*/).ai_;
var componentsUtil = require('/marko$4.18.10/dist/runtime/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.h_;
var addComponentRootToKeyedElements = componentsUtil.aj_;
var ComponentDef = require('/marko$4.18.10/dist/runtime/components/ComponentDef'/*"./ComponentDef"*/);
var registry = require('/marko$4.18.10/dist/runtime/components/registry-browser'/*"./registry"*/);
var domData = require('/marko$4.18.10/dist/runtime/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.G_;
var serverRenderedGlobals = {};
var serverComponentRootNodes = {};
var keyedElementsByComponentId = {};

var FLAG_WILL_RERENDER_IN_BROWSER = 1;

function indexServerComponentBoundaries(node, runtimeId, stack) {
    var componentId;
    var ownerId;
    var ownerComponent;
    var keyedElements;
    var nextSibling;
    var runtimeLength = runtimeId.length;
    stack = stack || [];

    node = node.firstChild;
    while (node) {
        nextSibling = node.nextSibling;
        if (node.nodeType === 8) {
            // Comment node
            var commentValue = node.nodeValue;
            if (commentValue.slice(0, runtimeLength) === runtimeId) {
                var firstChar = commentValue[runtimeLength];

                if (firstChar === "^" || firstChar === "#") {
                    stack.push(node);
                } else if (firstChar === "/") {
                    var endNode = node;
                    var startNode = stack.pop();
                    var rootNode;

                    if (startNode.parentNode === endNode.parentNode) {
                        rootNode = createFragmentNode(startNode.nextSibling, endNode);
                    } else {
                        rootNode = createFragmentNode(endNode.parentNode.firstChild, endNode);
                    }

                    componentId = startNode.nodeValue.substring(runtimeLength + 1);
                    firstChar = startNode.nodeValue[runtimeLength];

                    if (firstChar === "^") {
                        var parts = componentId.split(/ /g);
                        var key = parts[2];
                        ownerId = parts[1];
                        componentId = parts[0];
                        if (ownerComponent = componentLookup[ownerId]) {
                            keyedElements = ownerComponent.m_;
                        } else {
                            keyedElements = keyedElementsByComponentId[ownerId] || (keyedElementsByComponentId[ownerId] = {});
                        }
                        addComponentRootToKeyedElements(keyedElements, key, rootNode, componentId);
                    }

                    serverComponentRootNodes[componentId] = rootNode;

                    startNode.parentNode.removeChild(startNode);
                    endNode.parentNode.removeChild(endNode);
                }
            }
        } else if (node.nodeType === 1) {
            // HTML element node
            var markoKey = node.getAttribute("data-marko-key");
            var markoProps = node.getAttribute("data-marko");
            if (markoKey) {
                var separatorIndex = markoKey.indexOf(" ");
                ownerId = markoKey.substring(separatorIndex + 1);
                markoKey = markoKey.substring(0, separatorIndex);
                if (ownerComponent = componentLookup[ownerId]) {
                    keyedElements = ownerComponent.m_;
                } else {
                    keyedElements = keyedElementsByComponentId[ownerId] || (keyedElementsByComponentId[ownerId] = {});
                }
                keyedElements[markoKey] = node;
            }
            if (markoProps) {
                markoProps = JSON.parse(markoProps);
                Object.keys(markoProps).forEach(function (key) {
                    if (key.slice(0, 2) === "on") {
                        eventDelegation._z_(key.slice(2));
                    }
                });
            }
            indexServerComponentBoundaries(node, runtimeId, stack);
        }

        node = nextSibling;
    }
}

function invokeComponentEventHandler(component, targetMethodName, args) {
    var method = component[targetMethodName];
    if (!method) {
        throw Error("Method not found: " + targetMethodName);
    }

    method.apply(component, args);
}

function addEventListenerHelper(el, eventType, isOnce, listener) {
    var eventListener = listener;
    if (isOnce) {
        eventListener = function (event) {
            listener(event);
            el.removeEventListener(eventType, eventListener);
        };
    }

    el.addEventListener(eventType, eventListener, false);

    return function remove() {
        el.removeEventListener(eventType, eventListener);
    };
}

function addDOMEventListeners(component, el, eventType, targetMethodName, isOnce, extraArgs, handles) {
    var removeListener = addEventListenerHelper(el, eventType, isOnce, function (event) {
        var args = [event, el];
        if (extraArgs) {
            args = extraArgs.concat(args);
        }

        invokeComponentEventHandler(component, targetMethodName, args);
    });
    handles.push(removeListener);
}

function initComponent(componentDef, doc) {
    var component = componentDef.k_;

    if (!component || !component.Z_) {
        return; // legacy
    }

    component.I_();
    component.X_ = doc;

    var isExisting = componentDef._C_;

    if (isExisting) {
        component._b_();
    }

    var domEvents = componentDef._B_;
    if (domEvents) {
        var eventListenerHandles = [];

        domEvents.forEach(function (domEventArgs) {
            // The event mapping is for a direct DOM event (not a custom event and not for bubblign dom events)

            var eventType = domEventArgs[0];
            var targetMethodName = domEventArgs[1];
            var eventEl = component.m_[domEventArgs[2]];
            var isOnce = domEventArgs[3];
            var extraArgs = domEventArgs[4];

            addDOMEventListeners(component, eventEl, eventType, targetMethodName, isOnce, extraArgs, eventListenerHandles);
        });

        if (eventListenerHandles.length) {
            component.M_ = eventListenerHandles;
        }
    }

    if (component.R_) {
        component.E_("update");
    } else {
        component.R_ = true;
        component.E_("mount");
    }
}

/**
 * This method is used to initialized components associated with UI components
 * rendered in the browser. While rendering UI components a "components context"
 * is added to the rendering context to keep up with which components are rendered.
 * When ready, the components can then be initialized by walking the component tree
 * in the components context (nested components are initialized before ancestor components).
 * @param  {Array<marko-components/lib/ComponentDef>} componentDefs An array of ComponentDef instances
 */
function initClientRendered(componentDefs, doc) {
    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any components
    eventDelegation.ad_(doc);

    doc = doc || defaultDocument;
    var len = componentDefs.length;
    var componentDef;
    var i;

    for (i = len; i--;) {
        componentDef = componentDefs[i];
        trackComponent(componentDef);
    }

    for (i = len; i--;) {
        componentDef = componentDefs[i];
        initComponent(componentDef, doc);
    }
}

/**
 * This method initializes all components that were rendered on the server by iterating over all
 * of the component IDs.
 */
function initServerRendered(renderedComponents, doc) {
    if (!renderedComponents) {
        renderedComponents = win.$components;

        if (renderedComponents && renderedComponents.forEach) {
            renderedComponents.forEach(function (renderedComponent) {
                initServerRendered(renderedComponent, doc);
            });
        }

        win.$components = {
            concat: initServerRendered
        };

        return;
    }

    doc = doc || defaultDocument;

    renderedComponents = warp10Finalize(renderedComponents);

    var componentDefs = renderedComponents.w;
    var typesArray = renderedComponents.t;
    var runtimeId = renderedComponents.r;

    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any components
    indexServerComponentBoundaries(doc, runtimeId);
    eventDelegation.ad_(doc);

    var globals = window.$MG;
    if (globals) {
        serverRenderedGlobals = warp10Finalize(globals);
        delete window.$MG;
    }

    // hydrate components top down (leaf nodes last)
    // and return an array of functions to mount these components
    var componentMountFns = componentDefs.map(function (componentDef) {
        componentDef = ComponentDef._I_(componentDef, typesArray, serverRenderedGlobals, registry);

        var mount = hydrateComponentAndGetMount(componentDef, doc);

        if (!mount) {
            // hydrateComponentAndGetMount will return false if there is not rootNode
            // for the component.  If this is the case, we'll wait until the
            // DOM has fully loaded to attempt to init the component again.
            doc.addEventListener("DOMContentLoaded", function () {
                mount = hydrateComponentAndGetMount(componentDef, doc);

                if (!mount) {
                    indexServerComponentBoundaries(doc, runtimeId);
                    mount = hydrateComponentAndGetMount(componentDef, doc);
                }

                mount();
            });
        }

        return mount;
    });

    // mount components bottom up (leaf nodes first)
    componentMountFns.reverse().forEach(function (mount) {
        if (mount) mount();
    });
}

function hydrateComponentAndGetMount(componentDef, doc) {
    var componentId = componentDef.id;
    var component = componentDef.k_;
    var rootNode = serverComponentRootNodes[componentId];
    var renderResult;

    if (rootNode) {
        delete serverComponentRootNodes[componentId];

        component.K_ = rootNode;
        componentsByDOMNode.set(rootNode, component);
        component.m_ = keyedElementsByComponentId[componentId] || {};

        delete keyedElementsByComponentId[componentId];

        if (componentDef.g_ & FLAG_WILL_RERENDER_IN_BROWSER) {
            component.X_ = doc;
            renderResult = component._p_(component.Q_, true);
            trackComponent(componentDef);
            return function mount() {
                renderResult.afterInsert(doc);
            };
        } else {
            trackComponent(componentDef);
        }

        return function mount() {
            initComponent(componentDef, doc);
        };
    }
}

function trackComponent(componentDef) {
    var component = componentDef.k_;
    if (component) {
        componentLookup[component.id] = component;
    }
}

exports._M_ = initClientRendered;
exports.ag_ = initServerRendered;
});
$_mod.def("/marko$4.18.10/dist/runtime/components/index-browser", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.18.10/dist/runtime/components/util-browser'/*"./util"*/);
var initComponents = require('/marko$4.18.10/dist/runtime/components/init-components-browser'/*"./init-components"*/);
var registry = require('/marko$4.18.10/dist/runtime/components/registry-browser'/*"./registry"*/);

require('/marko$4.18.10/dist/runtime/components/ComponentsContext'/*"./ComponentsContext"*/)._M_ = initComponents._M_;

exports.getComponentForEl = componentsUtil.af_;
exports.init = window.$initComponents = initComponents.ag_;

exports.register = function (id, component) {
    registry.ae_(id, function () {
        return component;
    });
};
});
$_mod.def("/marko$4.18.10/components-browser.marko", function(require, exports, module, __filename, __dirname) { module.exports = require('/marko$4.18.10/dist/runtime/components/index-browser'/*"./dist/runtime/components"*/);

});
$_mod.def("/app$1.0.0/src/components/a-rel/component-browser", function(require, exports, module, __filename, __dirname) { var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

module.exports = function () {
    function _class() {
        _classCallCheck(this, _class);
    }

    _createClass(_class, [{
        key: "onInput",
        value: function onInput(input, out) {}
    }]);

    return _class;
}();
});
$_mod.def("/app$1.0.0/src/components/a-rel/index.marko.register", function(require, exports, module, __filename, __dirname) { require('/marko$4.18.10/components-browser.marko'/*'marko/components'*/).register("/app$1.0.0/src/components/a-rel/component-browser", require('/app$1.0.0/src/components/a-rel/component-browser'/*"./component-browser"*/));
});
$_mod.run("/app$1.0.0/src/components/a-rel/index.marko.register");
$_mod.def("/app$1.0.0/src/routes/hello/index.marko.init", function(require, exports, module, __filename, __dirname) { window.$initComponents && window.$initComponents();
});
$_mod.run("/app$1.0.0/src/routes/hello/index.marko.init");