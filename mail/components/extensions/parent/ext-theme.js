/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global windowTracker, EventManager, EventEmitter */

ChromeUtils.defineESModuleGetters(this, {
  LightweightThemeManager:
    "resource://gre/modules/LightweightThemeManager.sys.mjs",
});

const onUpdatedEmitter = new EventEmitter();

// Represents an empty theme for convenience of use
const emptyTheme = {
  details: { colors: null, images: null, properties: null },
};

let defaultTheme = emptyTheme;
// Map[windowId -> Theme instance]
const windowOverrides = new Map();

/**
 * Class representing either a global theme affecting all windows or an override on a specific window.
 * Any extension updating the theme with a new global theme will replace the singleton defaultTheme.
 */
class Theme {
  /**
   * Creates a theme instance.
   *
   * @param {object} options
   * @param {string} options.extension - Extension that created the theme.
   * @param {Integer} options.windowId - The windowId where the theme is applied.
   * @param {object} options.details
   * @param {object} options.darkDetails
   * @param {object} options.experiment
   * @param {object} options.startupData - startupData if this is a static theme.
   */
  constructor({
    extension,
    details,
    darkDetails,
    windowId,
    experiment,
    startupData,
  }) {
    this.extension = extension;
    this.details = details;
    this.darkDetails = darkDetails;
    this.windowId = windowId;

    if (startupData?.lwtData) {
      // Parsed theme from a previous load() already available in startupData
      // of parsed theme. We assume that reparsing the theme will yield the same
      // result, and therefore reuse the value of startupData. This is a minor
      // optimization; the more important use of startupData is before startup,
      // by Extension.sys.mjs for LightweightThemeManager.fallbackThemeData.
      //
      // Note: the assumption "yield the same result" is not obviously true: the
      // startupData persists across application updates, so it is possible for
      // a browser update to occur that interprets the static theme differently.
      // In this case we would still be using the old interpretation instead of
      // the new one, until the user disables and re-enables/installs the theme.
      this.lwtData = startupData.lwtData;
      this.lwtStyles = startupData.lwtStyles;
      this.lwtDarkStyles = startupData.lwtDarkStyles;
      this.experiment = startupData.experiment;
    } else {
      // lwtData will be populated by load().
      this.lwtData = null;
      // TODO: Update this part after bug 1550090.
      this.lwtStyles = {};
      this.lwtDarkStyles = darkDetails ? {} : null;

      this.experiment = null;

      if (experiment) {
        if (extension.canUseThemeExperiment()) {
          this.lwtStyles.experimental = {
            colors: {},
            images: {},
            properties: {},
          };
          if (this.lwtDarkStyles) {
            this.lwtDarkStyles.experimental = {
              colors: {},
              images: {},
              properties: {},
            };
          }

          if (experiment.stylesheet) {
            experiment.stylesheet = this.getFileUrl(experiment.stylesheet);
          }
          this.experiment = experiment;
        } else {
          const { logger } = this.extension;
          logger.warn("This extension is not allowed to run theme experiments");
          return;
        }
      }
    }
    this.load();
  }

  // The manifest has moz-extension:// urls. Switch to file:// urls to get around
  // the skin limitation for moz-extension:// urls.
  getFileUrl(url) {
    if (url.startsWith("moz-extension://")) {
      url = url.split("/").slice(3).join("/");
    }
    return this.extension.rootURI.resolve(url);
  }

  /**
   * Loads a theme by reading the properties from the extension's manifest.
   * This method will override any currently applied theme.
   */
  load() {
    // this.lwtData is usually null, unless populated from startupData.
    if (!this.lwtData) {
      this.loadDetails(this.details, this.lwtStyles);
      if (this.darkDetails) {
        this.loadDetails(this.darkDetails, this.lwtDarkStyles);
      }

      this.lwtData = {
        theme: this.lwtStyles,
        darkTheme: this.lwtDarkStyles,
      };

      if (this.experiment) {
        this.lwtData.experiment = this.experiment;
      }

      if (this.extension.type === "theme") {
        // Store the parsed theme in startupData, so it is available early at
        // browser startup, to use as LightweightThemeManager.fallbackThemeData,
        // which is assigned from Extension.sys.mjs to avoid having to wait for
        // this ext-theme.js file to be loaded.
        this.extension.startupData = {
          lwtData: this.lwtData,
          lwtStyles: this.lwtStyles,
          lwtDarkStyles: this.lwtDarkStyles,
          experiment: this.experiment,
        };
        this.extension.saveStartupData();
      }
    }

    if (this.windowId) {
      this.lwtData.window = windowTracker.getWindow(
        this.windowId
      ).docShell.outerWindowID;
      windowOverrides.set(this.windowId, this);
    } else {
      windowOverrides.clear();
      defaultTheme = this;
      LightweightThemeManager.fallbackThemeData = this.lwtData;
    }
    onUpdatedEmitter.emit("theme-updated", this.details, this.windowId);

    Services.obs.notifyObservers(
      this.lwtData,
      "lightweight-theme-styling-update"
    );
  }

  /**
   * @param {object} details - Details
   * @param {object} styles - Styles object in which to store the colors.
   */
  loadDetails(details, styles) {
    if (details.colors) {
      this.loadColors(details.colors, styles);
    }

    if (details.images) {
      this.loadImages(details.images, styles);
    }

    if (details.properties) {
      this.loadProperties(details.properties, styles);
    }

    this.loadMetadata(this.extension, styles);
  }

  /**
   * Helper method for loading colors found in the extension's manifest.
   *
   * @param {object} colors - Dictionary mapping color properties to values.
   * @param {object} styles - Styles object in which to store the colors.
   */
  loadColors(colors, styles) {
    for (const color of Object.keys(colors)) {
      const val = colors[color];

      if (!val) {
        continue;
      }

      let cssColor = val;
      if (Array.isArray(val)) {
        cssColor =
          "rgb" + (val.length > 3 ? "a" : "") + "(" + val.join(",") + ")";
      }

      switch (color) {
        case "frame":
          styles.accentcolor = cssColor;
          break;
        case "frame_inactive":
          styles.accentcolorInactive = cssColor;
          break;
        case "tab_background_text":
          styles.textcolor = cssColor;
          break;
        case "toolbar":
          styles.toolbarColor = cssColor;
          break;
        case "toolbar_text":
        case "bookmark_text":
          styles.toolbar_text = cssColor;
          break;
        case "icons":
          styles.icon_color = cssColor;
          break;
        case "icons_attention":
          styles.icon_attention_color = cssColor;
          break;
        case "tab_background_separator":
        case "tab_loading":
        case "tab_text":
        case "tab_line":
        case "tab_selected":
        case "toolbar_field":
        case "toolbar_field_text":
        case "toolbar_field_border":
        case "toolbar_field_focus":
        case "toolbar_field_text_focus":
        case "toolbar_field_border_focus":
        case "toolbar_top_separator":
        case "toolbar_bottom_separator":
        case "toolbar_vertical_separator":
        case "button_background_hover":
        case "button_background_active":
        case "popup":
        case "popup_text":
        case "popup_border":
        case "popup_highlight":
        case "popup_highlight_text":
        case "ntp_background":
        case "ntp_text":
        case "sidebar":
        case "sidebar_border":
        case "sidebar_text":
        case "sidebar_highlight":
        case "sidebar_highlight_text":
        case "sidebar_highlight_border":
        case "toolbar_field_highlight":
        case "toolbar_field_highlight_text":
          styles[color] = cssColor;
          break;
        default:
          if (
            this.experiment &&
            this.experiment.colors &&
            color in this.experiment.colors
          ) {
            styles.experimental.colors[color] = cssColor;
          } else {
            const { logger } = this.extension;
            logger.warn(`Unrecognized theme property found: colors.${color}`);
          }
          break;
      }
    }
  }

  /**
   * Helper method for loading images found in the extension's manifest.
   *
   * @param {object} images - Dictionary mapping image properties to values.
   * @param {object} styles - Styles object in which to store the colors.
   */
  loadImages(images, styles) {
    const { logger } = this.extension;

    for (const image of Object.keys(images)) {
      const val = images[image];

      if (!val) {
        continue;
      }

      switch (image) {
        case "additional_backgrounds": {
          const backgroundImages = val.map(img => this.getFileUrl(img));
          styles.additionalBackgrounds = backgroundImages;
          break;
        }
        case "theme_frame": {
          const resolvedURL = this.getFileUrl(val);
          styles.headerURL = resolvedURL;
          break;
        }
        default: {
          if (
            this.experiment &&
            this.experiment.images &&
            image in this.experiment.images
          ) {
            styles.experimental.images[image] = this.getFileUrl(val);
          } else {
            logger.warn(`Unrecognized theme property found: images.${image}`);
          }
          break;
        }
      }
    }
  }

  /**
   * Helper method for preparing properties found in the extension's manifest.
   * Properties are commonly used to specify more advanced behavior of colors,
   * images or icons.
   *
   * @param {object} properties - Dictionary mapping properties to values.
   * @param {object} styles - Styles object in which to store the colors.
   */
  loadProperties(properties, styles) {
    const additionalBackgroundsCount =
      (styles.additionalBackgrounds && styles.additionalBackgrounds.length) ||
      0;
    const assertValidAdditionalBackgrounds = (property, valueCount) => {
      const { logger } = this.extension;
      if (!additionalBackgroundsCount) {
        logger.warn(
          `The '${property}' property takes effect only when one ` +
            `or more additional background images are specified using the 'additional_backgrounds' property.`
        );
        return false;
      }
      if (additionalBackgroundsCount !== valueCount) {
        logger.warn(
          `The amount of values specified for '${property}' ` +
            `(${valueCount}) is not equal to the amount of additional background ` +
            `images (${additionalBackgroundsCount}), which may lead to unexpected results.`
        );
      }
      return true;
    };

    for (const property of Object.getOwnPropertyNames(properties)) {
      const val = properties[property];

      if (!val) {
        continue;
      }

      switch (property) {
        case "additional_backgrounds_alignment": {
          if (!assertValidAdditionalBackgrounds(property, val.length)) {
            break;
          }

          styles.backgroundsAlignment = val.join(",");
          break;
        }
        case "additional_backgrounds_tiling": {
          if (!assertValidAdditionalBackgrounds(property, val.length)) {
            break;
          }

          const tiling = [];
          for (let i = 0, l = styles.additionalBackgrounds.length; i < l; ++i) {
            tiling.push(val[i] || "no-repeat");
          }
          styles.backgroundsTiling = tiling.join(",");
          break;
        }
        case "color_scheme":
        case "content_color_scheme": {
          styles[property] = val;
          break;
        }
        default: {
          if (
            this.experiment &&
            this.experiment.properties &&
            property in this.experiment.properties
          ) {
            styles.experimental.properties[property] = val;
          } else {
            const { logger } = this.extension;
            logger.warn(
              `Unrecognized theme property found: properties.${property}`
            );
          }
          break;
        }
      }
    }
  }

  /**
   * Helper method for loading extension metadata required by downstream
   * consumers.
   *
   * @param {object} extension - Extension object.
   * @param {object} styles - Styles object in which to store the colors.
   */
  loadMetadata(extension, styles) {
    styles.id = extension.id;
    styles.version = extension.version;
  }

  static unload(windowId) {
    const lwtData = {
      theme: null,
    };

    if (windowId) {
      lwtData.window = windowTracker.getWindow(windowId).docShell.outerWindowID;
      windowOverrides.delete(windowId);
    } else {
      windowOverrides.clear();
      defaultTheme = emptyTheme;
      LightweightThemeManager.fallbackThemeData = null;
    }
    onUpdatedEmitter.emit("theme-updated", {}, windowId);

    Services.obs.notifyObservers(lwtData, "lightweight-theme-styling-update");
  }
}

this.theme = class extends ExtensionAPIPersistent {
  PERSISTENT_EVENTS = {
    // For primed persistent events (deactivated background), the context is only
    // available after fire.wakeup() has fulfilled (ensuring the convert() function
    // has been called).

    onUpdated({ fire, context }) {
      const callback = async (event, theme, windowId) => {
        if (fire.wakeup) {
          await fire.wakeup();
        }
        if (windowId) {
          // Force access validation for incognito mode by getting the window.
          if (windowTracker.getWindow(windowId, context, false)) {
            fire.async({ theme, windowId });
          }
        } else {
          fire.async({ theme });
        }
      };

      onUpdatedEmitter.on("theme-updated", callback);
      return {
        unregister() {
          onUpdatedEmitter.off("theme-updated", callback);
        },
        convert(newFire, extContext) {
          fire = newFire;
          context = extContext;
        },
      };
    },
  };

  onManifestEntry() {
    const { extension } = this;
    const { manifest } = extension;

    // Note: only static themes are processed here; extensions with the "theme"
    // permission do not enter this code path.
    defaultTheme = new Theme({
      extension,
      details: manifest.theme,
      darkDetails: manifest.dark_theme,
      experiment: manifest.theme_experiment,
      startupData: extension.startupData,
    });
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }

    const { extension } = this;
    for (const [windowId, theme] of windowOverrides) {
      if (theme.extension === extension) {
        Theme.unload(windowId);
      }
    }

    if (defaultTheme.extension === extension) {
      Theme.unload();
    }
  }

  getAPI(context) {
    const { extension } = context;

    return {
      theme: {
        getCurrent: windowId => {
          // Take last focused window when no ID is supplied.
          if (!windowId) {
            windowId = windowTracker.getId(windowTracker.topWindow);
          }
          // Force access validation for incognito mode by getting the window.
          if (!windowTracker.getWindow(windowId, context)) {
            return Promise.reject(`Invalid window ID: ${windowId}`);
          }

          if (windowOverrides.has(windowId)) {
            return Promise.resolve(windowOverrides.get(windowId).details);
          }
          return Promise.resolve(defaultTheme.details);
        },
        update: (windowId, details) => {
          if (windowId) {
            const browserWindow = windowTracker.getWindow(windowId, context);
            if (!browserWindow) {
              return Promise.reject(`Invalid window ID: ${windowId}`);
            }
          }

          new Theme({
            extension,
            details,
            windowId,
            experiment: this.extension.manifest.theme_experiment,
          });

          return Promise.resolve();
        },
        reset: windowId => {
          if (windowId) {
            const browserWindow = windowTracker.getWindow(windowId, context);
            if (!browserWindow) {
              return Promise.reject(`Invalid window ID: ${windowId}`);
            }

            const theme = windowOverrides.get(windowId) || defaultTheme;
            if (theme.extension !== extension) {
              return Promise.resolve();
            }
          } else if (defaultTheme.extension !== extension) {
            return Promise.resolve();
          }

          Theme.unload(windowId);
          return Promise.resolve();
        },
        onUpdated: new EventManager({
          context,
          module: "theme",
          event: "onUpdated",
          extensionApi: this,
        }).api(),
      },
    };
  }
};
