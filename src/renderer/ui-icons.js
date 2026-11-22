/* Generated offline Lucide UI icons. ISC / Feather MIT; see assets/icons/lucide/LICENSE. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.UIIcons = api; api.mount(root.document); }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  const catalogue = freeze({
  "close": {
    "source": "x",
    "description": "The complete close mark contracts slightly, then returns to rest.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "close-mark",
        "channel": "primary",
        "motion": "close-settle",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M18 6 6 18"
            }
          },
          {
            "tag": "path",
            "attributes": {
              "d": "m6 6 12 12"
            }
          }
        ]
      }
    ]
  },
  "minimize": {
    "source": "minus",
    "description": "The single minimize bar lowers briefly toward the window edge.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "minimize-bar",
        "channel": "primary",
        "motion": "minimize-drop",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M5 12h14"
            }
          }
        ]
      }
    ]
  },
  "settings": {
    "source": "settings",
    "description": "The complete gear turns about its fixed central hub.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "gear",
        "channel": "primary",
        "motion": "gear-turn",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"
            }
          }
        ]
      },
      {
        "name": "gear-hub",
        "channel": "secondary",
        "motion": "none",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "circle",
            "attributes": {
              "cx": "12",
              "cy": "12",
              "r": "3"
            }
          }
        ]
      }
    ]
  },
  "widgets": {
    "source": "layout-grid",
    "description": "The four layout cells settle in place without changing their spacing.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "layout-cells",
        "channel": "primary",
        "motion": "grid-settle",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "rect",
            "attributes": {
              "width": "7",
              "height": "7",
              "x": "3",
              "y": "3",
              "rx": "1"
            }
          },
          {
            "tag": "rect",
            "attributes": {
              "width": "7",
              "height": "7",
              "x": "14",
              "y": "3",
              "rx": "1"
            }
          },
          {
            "tag": "rect",
            "attributes": {
              "width": "7",
              "height": "7",
              "x": "14",
              "y": "14",
              "rx": "1"
            }
          },
          {
            "tag": "rect",
            "attributes": {
              "width": "7",
              "height": "7",
              "x": "3",
              "y": "14",
              "rx": "1"
            }
          }
        ]
      }
    ]
  },
  "grip": {
    "source": "grip-vertical",
    "description": "The complete neutral grip lifts slightly to suggest a draggable surface.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "grip-dots",
        "channel": "primary",
        "motion": "grip-lift",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "circle",
            "attributes": {
              "cx": "9",
              "cy": "12",
              "r": "1"
            }
          },
          {
            "tag": "circle",
            "attributes": {
              "cx": "9",
              "cy": "5",
              "r": "1"
            }
          },
          {
            "tag": "circle",
            "attributes": {
              "cx": "9",
              "cy": "19",
              "r": "1"
            }
          },
          {
            "tag": "circle",
            "attributes": {
              "cx": "15",
              "cy": "12",
              "r": "1"
            }
          },
          {
            "tag": "circle",
            "attributes": {
              "cx": "15",
              "cy": "5",
              "r": "1"
            }
          },
          {
            "tag": "circle",
            "attributes": {
              "cx": "15",
              "cy": "19",
              "r": "1"
            }
          }
        ]
      }
    ]
  },
  "chevron-down": {
    "source": "chevron-down",
    "description": "A single-colour chevron points gently downward, then rests.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "chevron",
        "channel": "primary",
        "motion": "chevron-guide",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "m6 9 6 6 6-6"
            }
          }
        ]
      }
    ]
  },
  "check": {
    "source": "check",
    "description": "The complete single-colour confirmation mark settles into place.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "confirmation",
        "channel": "primary",
        "motion": "confirm-settle",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M20 6 9 17l-5-5"
            }
          }
        ]
      }
    ]
  },
  "search": {
    "source": "search",
    "description": "The coherent magnifier makes a short horizontal scan.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "magnifier-handle",
        "channel": "primary",
        "motion": "search-scan",
        "origin": "11px 11px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "m21 21-4.34-4.34"
            }
          }
        ]
      },
      {
        "name": "magnifier-lens",
        "channel": "secondary",
        "motion": "search-scan",
        "origin": "11px 11px",
        "nodes": [
          {
            "tag": "circle",
            "attributes": {
              "cx": "11",
              "cy": "11",
              "r": "8"
            }
          }
        ]
      }
    ]
  },
  "clipboard": {
    "source": "clipboard-copy",
    "description": "The copy arrow moves left from a stationary clipboard.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "clipboard",
        "channel": "primary",
        "motion": "none",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "rect",
            "attributes": {
              "width": "8",
              "height": "4",
              "x": "8",
              "y": "2",
              "rx": "1",
              "ry": "1"
            }
          },
          {
            "tag": "path",
            "attributes": {
              "d": "M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
            }
          },
          {
            "tag": "path",
            "attributes": {
              "d": "M16 4h2a2 2 0 0 1 2 2v4"
            }
          }
        ]
      },
      {
        "name": "copy-arrow",
        "channel": "secondary",
        "motion": "send-left",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M21 14H11"
            }
          },
          {
            "tag": "path",
            "attributes": {
              "d": "m15 10-4 4 4 4"
            }
          }
        ]
      }
    ]
  },
  "notepad": {
    "source": "square-pen",
    "description": "The pen makes a short writing stroke inside a stationary note frame.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "note-frame",
        "channel": "primary",
        "motion": "none",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"
            }
          }
        ]
      },
      {
        "name": "note-pen",
        "channel": "secondary",
        "motion": "pencil-write",
        "origin": "9px 15px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"
            }
          }
        ]
      }
    ]
  },
  "x-mark": {
    "source": "x",
    "description": "The complete close mark contracts slightly, then returns to rest.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "close-mark",
        "channel": "primary",
        "motion": "close-settle",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M18 6 6 18"
            }
          },
          {
            "tag": "path",
            "attributes": {
              "d": "m6 6 12 12"
            }
          }
        ]
      }
    ]
  },
  "refresh": {
    "source": "refresh-cw",
    "description": "Both complete refresh arrows rotate together and pause after a full turn.",
    "fit": 0.84,
    "filled": false,
    "parts": [
      {
        "name": "refresh-arcs",
        "channel": "primary",
        "motion": "refresh-turn",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"
            }
          },
          {
            "tag": "path",
            "attributes": {
              "d": "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"
            }
          }
        ]
      },
      {
        "name": "refresh-arrowheads",
        "channel": "secondary",
        "motion": "refresh-turn",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M21 3v5h-5"
            }
          },
          {
            "tag": "path",
            "attributes": {
              "d": "M8 16H3v5"
            }
          }
        ]
      }
    ]
  },
  "map-pin": {
    "source": "map-pin",
    "description": "The complete pin settles at its location with its centre remaining aligned.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "pin-shell",
        "channel": "primary",
        "motion": "pin-settle",
        "origin": "12px 22px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"
            }
          }
        ]
      },
      {
        "name": "pin-centre",
        "channel": "secondary",
        "motion": "pin-settle",
        "origin": "12px 22px",
        "nodes": [
          {
            "tag": "circle",
            "attributes": {
              "cx": "12",
              "cy": "10",
              "r": "3"
            }
          }
        ]
      }
    ]
  },
  "map-center": {
    "source": "crosshair",
    "description": "The coherent crosshair focuses inward slightly, then rests.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "target-ring",
        "channel": "primary",
        "motion": "target-focus",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "circle",
            "attributes": {
              "cx": "12",
              "cy": "12",
              "r": "10"
            }
          }
        ]
      },
      {
        "name": "target-guides",
        "channel": "secondary",
        "motion": "target-focus",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "line",
            "attributes": {
              "x1": "22",
              "x2": "18",
              "y1": "12",
              "y2": "12"
            }
          },
          {
            "tag": "line",
            "attributes": {
              "x1": "6",
              "x2": "2",
              "y1": "12",
              "y2": "12"
            }
          },
          {
            "tag": "line",
            "attributes": {
              "x1": "12",
              "x2": "12",
              "y1": "6",
              "y2": "2"
            }
          },
          {
            "tag": "line",
            "attributes": {
              "x1": "12",
              "x2": "12",
              "y1": "22",
              "y2": "18"
            }
          }
        ]
      }
    ]
  },
  "expand": {
    "source": "maximize",
    "description": "Four corners move a short distance in their own outward directions.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "north-west-corner",
        "channel": "primary",
        "motion": "expand-nw",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M8 3H5a2 2 0 0 0-2 2v3"
            }
          }
        ]
      },
      {
        "name": "north-east-corner",
        "channel": "primary",
        "motion": "expand-ne",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M21 8V5a2 2 0 0 0-2-2h-3"
            }
          }
        ]
      },
      {
        "name": "south-west-corner",
        "channel": "primary",
        "motion": "expand-sw",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M3 16v3a2 2 0 0 0 2 2h3"
            }
          }
        ]
      },
      {
        "name": "south-east-corner",
        "channel": "primary",
        "motion": "expand-se",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M16 21h3a2 2 0 0 0 2-2v-3"
            }
          }
        ]
      }
    ]
  },
  "info": {
    "source": "info",
    "description": "The information mark lifts slightly inside its stationary circle.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "information-circle",
        "channel": "primary",
        "motion": "none",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "circle",
            "attributes": {
              "cx": "12",
              "cy": "12",
              "r": "10"
            }
          }
        ]
      },
      {
        "name": "information-mark",
        "channel": "secondary",
        "motion": "info-attend",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M12 16v-4"
            }
          },
          {
            "tag": "path",
            "attributes": {
              "d": "M12 8h.01"
            }
          }
        ]
      }
    ]
  },
  "eye": {
    "source": "eye",
    "description": "The eye blinks coherently, with the iris and eyelid moving together.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "eyelid",
        "channel": "primary",
        "motion": "eye-blink",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
            }
          }
        ]
      },
      {
        "name": "iris",
        "channel": "secondary",
        "motion": "eye-blink",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "circle",
            "attributes": {
              "cx": "12",
              "cy": "12",
              "r": "3"
            }
          }
        ]
      }
    ]
  },
  "palette": {
    "source": "palette",
    "description": "The palette stays fixed while two meaningful pigment groups catch light.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "palette-shell",
        "channel": "primary",
        "motion": "none",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"
            }
          }
        ]
      },
      {
        "name": "cool-pigments",
        "channel": "secondary",
        "motion": "read-first",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "circle",
            "attributes": {
              "cx": "13.5",
              "cy": "6.5",
              "r": ".5",
              "fill": "currentColor"
            }
          },
          {
            "tag": "circle",
            "attributes": {
              "cx": "17.5",
              "cy": "10.5",
              "r": ".5",
              "fill": "currentColor"
            }
          }
        ]
      },
      {
        "name": "warm-pigments",
        "channel": "detail",
        "motion": "read-second",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "circle",
            "attributes": {
              "cx": "6.5",
              "cy": "12.5",
              "r": ".5",
              "fill": "currentColor"
            }
          },
          {
            "tag": "circle",
            "attributes": {
              "cx": "8.5",
              "cy": "7.5",
              "r": ".5",
              "fill": "currentColor"
            }
          }
        ]
      }
    ]
  },
  "link": {
    "source": "link",
    "description": "Two complete links move slightly together, then return to rest.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "first-link",
        "channel": "primary",
        "motion": "link-first",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
            }
          }
        ]
      },
      {
        "name": "second-link",
        "channel": "secondary",
        "motion": "link-second",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
            }
          }
        ]
      }
    ]
  },
  "folder": {
    "source": "folder-open",
    "description": "The single folder silhouette opens slightly from its lower hinge.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "folder",
        "channel": "primary",
        "motion": "folder-open",
        "origin": "4px 20px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
            }
          }
        ]
      }
    ]
  },
  "book-open": {
    "source": "book-open",
    "description": "The pages open slightly around a stationary book spine.",
    "fit": 1,
    "filled": false,
    "parts": [
      {
        "name": "book-spine",
        "channel": "primary",
        "motion": "none",
        "origin": "12px 12px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M12 5v16"
            }
          }
        ]
      },
      {
        "name": "book-pages",
        "channel": "secondary",
        "motion": "book-open",
        "origin": "12px 13px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"
            }
          }
        ]
      }
    ]
  },
  "market": {
    "source": "overkot-market-sack",
    "description": "The original single-colour market sack settles under its weight; a local optical fit balances its filled silhouette.",
    "fit": 0.9,
    "filled": true,
    "parts": [
      {
        "name": "market-sack",
        "channel": "primary",
        "motion": "bag-settle",
        "origin": "12px 22px",
        "nodes": [
          {
            "tag": "path",
            "attributes": {
              "d": "M7.8 2.2c-.6-.2-1.1.4-.8.9L9.4 7h5.2L17 3.1c.3-.5-.2-1.1-.8-.9l-2 .6a7.5 7.5 0 0 1-4.4 0zM9 8a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2z"
            }
          },
          {
            "tag": "path",
            "attributes": {
              "d": "M9.1 10.8C6 13.2 3 16.4 3 19c0 2.1 2 3 5 3h8c3 0 5-.9 5-3 0-2.6-3-5.8-6.1-8.2z"
            }
          }
        ]
      }
    ]
  }
});
  const ids = Object.freeze(Object.keys(catalogue));
  const sources = Object.freeze(Object.fromEntries(ids.map(id => [id, catalogue[id].source])));
  function create(id, document = globalThis.document) {
    if (!Object.hasOwn(catalogue, id)) throw new Error('Unknown ui icon: ' + String(id));
    if (!document || typeof document.createElementNS !== 'function') throw new TypeError('Icons need a DOM document');
    const value = catalogue[id];
    const node = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);
    const svg = node('svg');
    const attributes = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', class: 'overkot-icon',
      'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', focusable: 'false', 'data-ui-icon': id, 'data-icon-source': value.source,
      'data-icon-fit': String(value.fit), 'data-icon-motion-kind': value.parts.find(part => part.motion !== 'none').motion };
    for (const [name, attribute] of Object.entries(attributes)) svg.setAttribute(name, attribute);
    let canvas = svg;
    if (value.fit !== 1) {
      canvas = node('g'); canvas.setAttribute('data-icon-canvas', '');
      canvas.setAttribute('transform', 'translate(12 12) scale(' + value.fit + ') translate(-12 -12)');
      svg.appendChild(canvas);
    }
    for (const part of value.parts) {
      const group = node('g');
      group.setAttribute('data-icon-part', part.name);
      group.setAttribute('data-icon-layer', part.channel);
      group.setAttribute('data-icon-animation', part.motion);
      group.setAttribute('style', 'transform-origin:' + part.origin);
      if (value.filled) group.setAttribute('data-icon-filled', 'true');
      for (const shape of part.nodes) {
        const primitive = node(shape.tag);
        for (const [name, attribute] of Object.entries(shape.attributes)) primitive.setAttribute(name, attribute);
        group.appendChild(primitive);
      }
      canvas.appendChild(group);
    }
    return svg;
  }

  function mount(document) {
    if (!document || typeof document.querySelectorAll !== 'function') return;
    const selector = ids.map(id => '.icon-' + id).join(',');
    const hydrate = root => {
      const candidates = [...(root.querySelectorAll?.(selector) || [])];
      if (root.matches?.(selector)) candidates.unshift(root);
      for (const element of candidates) {
        const id = ids.find(name => element.classList.contains('icon-' + name));
        if (!id || element.querySelector('[data-ui-icon]')) continue;
        element.appendChild(create(id, document));
        element.classList.add('icon-hydrated');
      }
    };
    const start = () => {
      hydrate(document);
      document.defaultView?.OverkotTheme?.refreshIcons?.(document);
      const Observer = document.defaultView?.MutationObserver;
      if (!Observer) return;
      const observer = new Observer(records => {
        for (const record of records) {
          if (record.type === 'attributes') hydrate(record.target);
          else for (const node of record.addedNodes) if (node.nodeType === 1) {
            hydrate(node); document.defaultView?.OverkotTheme?.refreshIcons?.(node);
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      document.defaultView.addEventListener('unload', () => observer.disconnect(), { once: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
  return Object.freeze({ catalogue, sources, ids, create, mount });
});
