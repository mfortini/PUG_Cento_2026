/* Viewer Leaflet per PUG Cento — carica web/data/layers.json generato da prepare_web_publish.sh */

const overlayRefs = [];
const exclusiveLayers = new Set();
let activeOverlay = null;

function canonicalLayerId(item) {
  const id = item?.id || item?.title || "";
  return id.replace(/_modified$/, "");
}

function dedupeByLayerId(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = canonicalLayerId(item);
    if (!key) continue;
    const prev = byKey.get(key);
    if (
      !prev ||
      (/_modified$/.test(prev.id || prev.title || "") &&
        !/_modified$/.test(item.id || item.title || ""))
    ) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

const LayerPanelControl = L.Control.extend({
  initialize(pugChoices, onPugSelect, options) {
    L.Util.setOptions(this, options);
    this._pugChoices = pugChoices;
    this._onPugSelect = onPugSelect;
    this._selectedPug = null;
  },

  onAdd() {
    const container = L.DomUtil.create("div", "leaflet-control layer-radio-control");
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    const toggle = L.DomUtil.create("button", "layer-radio-toggle", container);
    toggle.type = "button";
    toggle.title = "Layer";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = "Layer";

    const panel = L.DomUtil.create("div", "layer-radio-panel", container);
    panel.hidden = true;
    this._form = L.DomUtil.create("div", "layer-radio-form", panel);

    L.DomEvent.on(toggle, "click", () => {
      const open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    this._container = container;
    this._render();
    return container;
  },

  setSelectedPug(layer) {
    this._selectedPug = layer;
    if (!this._form) return;
    const value = layer
      ? String(this._pugChoices.findIndex((c) => c.layer === layer))
      : "none";
    const input = this._form.querySelector(`input[name="pug-layer"][value="${value}"]`);
    if (input) input.checked = true;
  },

  _render() {
    this._form.innerHTML = "";

    const pugTitle = L.DomUtil.create("div", "layer-section-title", this._form);
    pugTitle.textContent = "Tavole PUG";

    const noneLabel = L.DomUtil.create("label", "layer-radio-item", this._form);
    const noneInput = L.DomUtil.create("input", "", noneLabel);
    noneInput.type = "radio";
    noneInput.name = "pug-layer";
    noneInput.value = "none";
    noneInput.checked = this._selectedPug === null;
    L.DomUtil.create("span", "", noneLabel).textContent = "Nessuno (solo mappa base)";
    L.DomEvent.on(noneInput, "change", () => {
      if (noneInput.checked) this._onPugSelect(null, null);
    });

    this._pugChoices.forEach((choice, index) => {
      const label = L.DomUtil.create("label", "layer-radio-item", this._form);
      const input = L.DomUtil.create("input", "", label);
      input.type = "radio";
      input.name = "pug-layer";
      input.value = String(index);
      input.checked = this._selectedPug === choice.layer;
      L.DomUtil.create("span", "", label).textContent = choice.label;
      L.DomEvent.on(input, "change", () => {
        if (input.checked) this._onPugSelect(choice.layer, choice.cfg);
      });
    });
  },
});

async function init() {
  const res = await fetch("data/layers.json");
  if (!res.ok) {
    document.getElementById("map").innerHTML =
      "<p style='padding:2rem'>Manca <code>data/layers.json</code>. Esegui <code>scripts/prepare_web_publish.sh</code>.</p>";
    return;
  }
  const cfg = await res.json();

  document.getElementById("map-title").textContent = cfg.title || "Mappa";
  if (cfg.description) {
    document.getElementById("map-desc").textContent = cfg.description;
  }

  const overlays = dedupeByLayerId(
    (cfg.overlays || []).filter((o) => o.type === "xyz")
  );
  const overlayMinZoom = overlays.length
    ? Math.min(...overlays.map((o) => o.minZoom ?? 10))
    : 10;
  const overlayMaxNativeZoom = overlays.length
    ? Math.max(...overlays.map((o) => o.maxZoom ?? 16))
    : 16;
  const mapMinZoom = cfg.minZoom ?? overlayMinZoom;
  const mapMaxZoom = cfg.maxZoom ?? overlayMaxNativeZoom + 2;
  const initialZoom = Math.min(
    Math.max(cfg.zoom ?? 12, mapMinZoom),
    overlayMaxNativeZoom
  );

  const map = L.map("map", {
    center: cfg.center || [44.73, 11.29],
    zoom: initialZoom,
    minZoom: mapMinZoom,
    maxZoom: mapMaxZoom,
  });

  const confinePane = map.createPane("confine");
  confinePane.style.zIndex = 450;

  let confineLayer = null;

  const basemapAttribution =
    (cfg.basemaps || []).find((b) => b.default)?.attribution || "&copy; OpenStreetMap";

  const attributionEl = document.getElementById("map-attribution");
  if (attributionEl) {
    attributionEl.innerHTML = basemapAttribution;
  }

  function bringConfineToFront() {
    if (confineLayer && map.hasLayer(confineLayer)) {
      confineLayer.bringToFront();
    }
  }

  (cfg.basemaps || []).forEach((b) => {
    const base = L.tileLayer(b.url, {
      attribution: b.attribution || "",
      maxZoom: 19,
    });
    if (b.default) base.addTo(map);
  });

  const defaultOpacity = cfg.defaultOpacity ?? overlays[0]?.opacity ?? 0.85;
  const opacityInput = document.getElementById("opacity");
  const opacityValue = document.getElementById("opacity-value");
  opacityInput.value = String(defaultOpacity);
  if (opacityValue) {
    opacityValue.textContent = `${Math.round(defaultOpacity * 100)}%`;
  }

  const pugChoices = [];
  let layerPanel = null;
  let pendingVisible = null;

  function registerPugChoice(layer, label, layerCfg) {
    const key = layerCfg?.id ? canonicalLayerId(layerCfg) : label;
    const existing = pugChoices.find((c) =>
      c.cfg?.id ? canonicalLayerId(c.cfg) === key : c.label === label
    );
    if (existing) return existing;

    exclusiveLayers.add(layer);
    const choice = { layer, label, cfg: layerCfg };
    pugChoices.push(choice);
    if (layerCfg?.bounds) {
      overlayRefs.push({ layer, cfg: layerCfg, label });
    }
    if (layerPanel?._form) {
      layerPanel._render();
    }
    return choice;
  }

  function selectPugOverlay(layer, layerCfg) {
    exclusiveLayers.forEach((other) => {
      if (map.hasLayer(other)) map.removeLayer(other);
    });

    activeOverlay = null;
    if (layer) {
      layer.addTo(map);
      activeOverlay = layer;
      if (layer.setOpacity) {
        layer.setOpacity(parseFloat(opacityInput.value));
      }
      if (layerCfg?.bounds) {
        map.fitBounds(L.latLngBounds(layerCfg.bounds), {
          maxZoom: overlayMaxNativeZoom,
        });
      }
    }

    if (layerPanel) {
      layerPanel.setSelectedPug(layer);
    }
    bringConfineToFront();
  }

  const sortedOverlays = [...overlays].sort((a, b) =>
    (a.title || "").localeCompare(b.title || "", "it", { sensitivity: "base" })
  );

  sortedOverlays.forEach((o) => {
    const scheme = o.scheme || "xyz";
    const nativeMax = o.maxZoom ?? overlayMaxNativeZoom;
    const layerOpacity = o.opacity ?? defaultOpacity;
    const layer = L.tileLayer(o.url, {
      minZoom: o.minZoom ?? mapMinZoom,
      maxNativeZoom: nativeMax,
      maxZoom: mapMaxZoom,
      opacity: layerOpacity,
      bounds: o.bounds ? L.latLngBounds(o.bounds) : undefined,
      tms: scheme === "tms",
    });
    const label = `[${o.group || "layer"}] ${o.title}`;
    const choice = registerPugChoice(layer, label, o);
    if (o.visible && pendingVisible === null) {
      pendingVisible = choice;
    }
  });

  layerPanel = new LayerPanelControl(pugChoices, selectPugOverlay, {
    position: "topright",
  });
  layerPanel.addTo(map);

  const sortedVectors = [...(cfg.vectors || [])].sort((a, b) =>
    (a.title || "").localeCompare(b.title || "", "it", { sensitivity: "base" })
  );

  const confineCfg = sortedVectors.find((v) => v.id === "confine");
  const overlayVectors = sortedVectors.filter((v) => v.id !== "confine");

  const confineToggle = document.getElementById("confine-toggle");
  const confineDefaultVisible = confineCfg?.visible !== false;

  function setConfineVisible(visible) {
    if (!confineLayer) return;
    if (visible) {
      confineLayer.addTo(map);
      confineLayer.bringToFront();
    } else {
      map.removeLayer(confineLayer);
    }
  }

  if (confineCfg) {
    try {
      const confineRes = await fetch(confineCfg.url);
      const geojson = await confineRes.json();
      confineLayer = L.geoJSON(geojson, {
        pane: "confine",
        style: confineCfg.style || { color: "#1d4ed8", weight: 2, fillOpacity: 0.05 },
        onEachFeature: (feature, lyr) => {
          const props = feature.properties || {};
          const html = Object.entries(props)
            .map(([k, val]) => `<strong>${k}</strong>: ${val}`)
            .join("<br>");
          if (html) lyr.bindPopup(html);
        },
      });
      if (confineToggle) {
        confineToggle.checked = confineDefaultVisible;
        confineToggle.addEventListener("change", () => {
          setConfineVisible(confineToggle.checked);
        });
      }
      if (confineDefaultVisible) {
        setConfineVisible(true);
      }
    } catch (err) {
      console.warn("Confine load failed:", confineCfg.url, err);
      if (confineToggle) confineToggle.disabled = true;
    }
  } else if (confineToggle) {
    confineToggle.disabled = true;
  }

  const vectorPromises = overlayVectors.map((v) =>
    fetch(v.url)
      .then((r) => r.json())
      .then((geojson) => {
        const layer = L.geoJSON(geojson, {
          style: v.style || { color: "#333", weight: 1 },
          onEachFeature: (feature, lyr) => {
            const props = feature.properties || {};
            const html = Object.entries(props)
              .map(([k, val]) => `<strong>${k}</strong>: ${val}`)
              .join("<br>");
            if (html) lyr.bindPopup(html);
          },
        });
        const choice = registerPugChoice(
          layer,
          v.title,
          v.bounds ? { bounds: v.bounds } : null
        );
        if (v.visible && pendingVisible === null) {
          pendingVisible = choice;
        }
        return choice;
      })
      .catch((err) => {
        console.warn("Vector load failed:", v.url, err);
        return null;
      })
  );

  await Promise.all(vectorPromises);

  if (pendingVisible) {
    selectPugOverlay(pendingVisible.layer, pendingVisible.cfg);
  } else {
    const bounds = [];
    overlayRefs.forEach(({ cfg: layerCfg }) => {
      if (layerCfg.bounds) bounds.push(L.latLngBounds(layerCfg.bounds));
    });
    if (bounds.length) {
      map.fitBounds(bounds.reduce((acc, b) => acc.extend(b)), {
        maxZoom: overlayMaxNativeZoom,
      });
    }
  }

  map.on("mousemove", (e) => {
    document.getElementById("coords").textContent =
      `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
  });

  opacityInput.addEventListener("input", (ev) => {
    const value = parseFloat(ev.target.value);
    if (opacityValue) {
      opacityValue.textContent = `${Math.round(value * 100)}%`;
    }
    if (activeOverlay?.setOpacity) {
      activeOverlay.setOpacity(value);
    }
  });
}

init();
