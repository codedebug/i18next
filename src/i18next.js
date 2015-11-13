import * as utils from './utils';
import baseLogger from './logger';
import EventEmitter from './EventEmitter';
import ResourceStore from './ResourceStore';
import Translator from './Translator';
import LanguageUtils from './LanguageUtils';
import PluralResolver from './PluralResolver';
import Interpolator from './Interpolator';
import BackendConnector from './BackendConnector';
import { get as getDefaults, transformOptions } from './defaults';
import postProcessor from './postProcessor';

import * as compat from './compatibility/v1';

class I18n extends EventEmitter {
  constructor(options = {}, callback) {
    super();
    this.options = options;
    this.services = {};
    this.logger = baseLogger;
    this.modules = {};

    if (callback && !this.isInitialized) this.init(options, callback);
  }

  init(options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options.compatibilityAPI === 'v1') {
      this.options = utils.defaults({}, transformOptions(compat.convertAPIOptions(options)), getDefaults());
    } else if (options.compatibilityJSON === 'v1') {
      this.options = utils.defaults({}, transformOptions(compat.convertJSONOptions(options)), getDefaults());
    } else {
      this.options = utils.defaults({}, transformOptions(options), this.options, getDefaults());
    }
    if (!callback) callback = () => {};

    function createClassOnDemand(ClassOrObject) {
      if (typeof ClassOrObject === 'function') return new ClassOrObject();
      return ClassOrObject;
    }

    // init services
    if (!this.options.isClone) {
      if (this.modules.logger) {
        baseLogger.init(createClassOnDemand(this.modules.logger), this.options);
      } else {
        baseLogger.init(null, this.options);
      }

      const lu = new LanguageUtils(this.options);
      this.store = new ResourceStore(this.options.resources, this.options);

      var s = this.services;
      s.logger = baseLogger;
      s.resourceStore = this.store;
      s.languageUtils = lu;
      s.pluralResolver = new PluralResolver(lu, {prepend: '_', compatibilityJSON:  this.options.compatibilityJSON});
      s.interpolator = new Interpolator(this.options);
      if (this.modules.backend) {
        s.backendConnector = new BackendConnector(createClassOnDemand(this.modules.backend), createClassOnDemand(this.modules.cache), s.resourceStore, s, this.options);
        // pipe events from backendConnector
        s.backendConnector.on('*', (event, ...args) => {
          this.emit(event, ...args);
        });
      }

      if (this.modules.languageDetector) {
        s.languageDetector = createClassOnDemand(this.modules.languageDetector);
        s.languageDetector.init(s, this.options.detection, this.options);
      }

      this.translator = new Translator(this.services, this.options);
      // pipe events from translator
      this.translator.on('*', (event, ...args) => {
        this.emit(event, ...args);
      });
    }

    // append api
    const storeApi = ['addResource', 'addResources', 'addResourceBundle', 'removeResourceBundle', 'hasResourceBundle', 'getResourceBundle'];
    storeApi.forEach(fcName => {
      this[fcName] = function() { return this.store[fcName].apply(this.store, arguments); };
    });

    // TODO: COMPATIBILITY remove this
    if (this.options.compatibilityAPI === 'v1') compat.appendBackwardsAPI(this);

    this.changeLanguage(this.options.lng, (err, t) => {
      this.emit('initialized', this.options);
      this.logger.log('initialized', this.options);

      callback(err, t);
    });
  }

  loadResources(callback) {
    if (!callback) callback = () => {};

    if (!this.options.resources && this.services.backendConnector) {
      let toLoad = [];

      let append = lng => {
        let lngs = this.services.languageUtils.toResolveHierarchy(lng);
        lngs.forEach(l => {
          if (toLoad.indexOf(l) < 0) toLoad.push(l);
        });
      };

      append(this.language);

      if (this.options.preload) {
        this.options.preload.forEach(l => {
          append(l);
        });
      }

      this.services.backendConnector.load(toLoad, this.options.ns, callback);
    } else {
      callback(null);
    }
  }

  use(module) {
    if (module.type === 'backend') {
      this.modules.backend = module;
    }

    if (module.type === 'cache') {
      this.modules.cache = module;
    }

    if (module.type === 'logger' || (module.log && module.warn && module.warn)) {
      this.modules.logger = module;
    }

    if (module.type === 'languageDetector') {
      this.modules.languageDetector = module;
    }

    if (module.type === 'postProcessor') {
      postProcessor.addPostProcessor(module);
    }

    return this;
  }

  // TODO: COMPATIBILITY remove this
  addPostProcessor(name, fc) {
    // TODO: deprecation warning
    this.use({
      type: 'postProcessor',
      name: name,
      process: fc
    });
  }

  changeLanguage(lng, callback) {
    let done = (err) => {
      this.emit('languageChanged', lng);
      this.logger.log('languageChanged', lng);

      if (callback) callback(err, (...args) => { return this.t.apply(this, args); });
    };

    if (!lng && this.services.languageDetector) lng = this.services.languageDetector.detect();

    if (lng) {
      this.language = lng;
      this.languages = this.services.languageUtils.toResolveHierarchy(lng);

      this.translator.changeLanguage(lng);

      if (this.services.languageDetector) this.services.languageDetector.cacheUserLanguage(lng);
    }

    this.loadResources((err) => {
      done(err);
    });
  }

  getFixedT(lng, ns) {
    let fixedT = (key, options) => {
      options = options || {};
      options.lng = options.lng || fixedT.lng;
      options.ns = options.ns || fixedT.ns;
      return this.t(key, options);
    };
    fixedT.lng = lng;
    fixedT.ns = ns;
    return fixedT;
  }

  t() {
    return this.translator && this.translator.translate.apply(this.translator, arguments);
  }

  exists() {
    return this.translator && this.translator.exists.apply(this.translator, arguments);
  }

  setDefaultNamespace(ns) {
    this.options.defaultNS = ns;
  }

  loadNamespaces(ns, callback) {
    if (!this.options.ns) return callback && callback();
    if (typeof ns === 'string') ns = [ns];

    ns.forEach(n => {
      if (this.options.ns.indexOf(n) < 0) this.options.ns.push(n);
    });

    this.loadResources(callback);
  }

  loadLanguages(lngs, callback) {
    if (typeof lngs === 'string') lngs = [lngs];
    this.options.preload = this.options.preload ? this.options.preload.concat(lngs) : lngs;

    this.loadResources(callback);
  }

  dir(lng) {
    if (!lng) lng = this.language;

    var ltrLngs = ['ar', 'shu', 'sqr', 'ssh', 'xaa', 'yhd', 'yud', 'aao', 'abh', 'abv', 'acm',
      'acq', 'acw', 'acx', 'acy', 'adf', 'ads', 'aeb', 'aec', 'afb', 'ajp', 'apc', 'apd', 'arb',
      'arq', 'ars', 'ary', 'arz', 'auz', 'avl', 'ayh', 'ayl', 'ayn', 'ayp', 'bbz', 'pga', 'he',
      'iw', 'ps', 'pbt', 'pbu', 'pst', 'prp', 'prd', 'ur', 'ydd', 'yds', 'yih', 'ji', 'yi', 'hbo',
      'men', 'xmn', 'fa', 'jpr', 'peo', 'pes', 'prs', 'dv', 'sam'
    ];

    return ltrLngs.indexOf(this.services.languageUtils.getLanguagePartFromCode(lng)) ? 'ltr' : 'rtl';
}

  createInstance(options = {}, callback) {
    return new I18n(options, callback);
  }

  cloneInstance(options = {}, callback) {
    let clone = new I18n(utils.extend(options, this.options, {isClone: true}), callback);
    const membersToCopy = ['store', 'translator', 'services', 'language'];
    membersToCopy.forEach(m => {
      clone[m] = this[m];
    });

    return clone;
  }
}

export default new I18n();
