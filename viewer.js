import * as pdfjsLib from "./pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.min.mjs";

const MANIFEST_URL = "./pdf-pages/manifest.json?v=20260806";
const PAGE_BASE_URL = "./pdf-pages/";
const PREVIEW_BASE_URL = "./pdf-pages/previews/";
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.15;
const MAX_CANVAS_DIMENSION = 8192;
const MAX_CANVAS_AREA = 40_000_000;

const scrollArea = document.querySelector("#pdf-scroll");
const pagesContainer = document.querySelector("#pdf-pages");
const loadingPanel = document.querySelector("#loading-panel");
const loadingLabel = document.querySelector("#loading-label");
const loadingProgress = document.querySelector("#loading-progress");
const errorPanel = document.querySelector("#error-panel");
const pageInput = document.querySelector("#page-input");
const pageCount = document.querySelector("#page-count");
const zoomLabel = document.querySelector("#zoom-label");

const controls = {
  previous: document.querySelector("#previous-page"),
  next: document.querySelector("#next-page"),
  zoomOut: document.querySelector("#zoom-out"),
  zoomIn: document.querySelector("#zoom-in"),
  fitWidth: document.querySelector("#fit-width"),
};

let pageEntries = [];
let assetVersion = "1";
let currentPage = 1;
let zoom = 1;
let layoutVersion = 1;
let pageObserver = null;
let resizeTimer = null;
let scrollTimer = null;
let zoomRenderTimer = null;
let lastNeighborhoodPage = 1;
let panState = null;
const pageRenders = new Map();

function pageGutter() {
  return window.matchMedia("(max-width: 600px)").matches ? 16 : 48;
}

function fitWidth() {
  return Math.max(240, scrollArea.clientWidth - pageGutter());
}

function renderPixelRatio(width, height) {
  const nativeRatio = Math.max(1, window.devicePixelRatio || 1);
  const dimensionRatio = Math.min(MAX_CANVAS_DIMENSION / width, MAX_CANVAS_DIMENSION / height);
  const areaRatio = Math.sqrt(MAX_CANVAS_AREA / Math.max(1, width * height));
  return Math.max(0.5, Math.min(nativeRatio, dimensionRatio, areaRatio));
}

function updateContainerWidth() {
  const width = Math.max(scrollArea.clientWidth, fitWidth() * zoom + pageGutter());
  pagesContainer.style.width = `${Math.round(width)}px`;
  scrollArea.classList.toggle("is-zoomed", width > scrollArea.clientWidth + 1);
}

function updateControls() {
  if (!pageEntries.length) return;
  const total = pageEntries.length;
  pageInput.value = String(currentPage);
  pageInput.max = String(total);
  pageCount.textContent = String(total);
  controls.previous.disabled = currentPage <= 1;
  controls.next.disabled = currentPage >= total;
  controls.zoomOut.disabled = zoom <= MIN_ZOOM;
  controls.zoomIn.disabled = zoom >= MAX_ZOOM;
  controls.fitWidth.disabled = zoom === 1;
  zoomLabel.textContent = zoom === 1 ? "适合宽度" : `${Math.round(zoom * 100)}%`;
}

function versionedAsset(path) {
  return `${path}?v=${encodeURIComponent(assetVersion)}`;
}

function waitForFirstPreview(timeout = 1200) {
  const image = getPageElement(1)?.querySelector(".page-placeholder");
  if (!image || image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      image.removeEventListener("load", finish);
      image.removeEventListener("error", finish);
      resolve();
    };
    image.addEventListener("load", finish, { once: true });
    image.addEventListener("error", finish, { once: true });
    window.setTimeout(finish, timeout);
  });
}

function createPageShells() {
  const fragment = document.createDocumentFragment();
  pageEntries.forEach((entry, index) => {
    const number = index + 1;
    const pageElement = document.createElement("article");
    pageElement.className = "pdf-page";
    pageElement.dataset.page = String(number);
    pageElement.setAttribute("aria-label", `第 ${number} 页`);

    const canvas = document.createElement("canvas");
    canvas.hidden = true;
    canvas.setAttribute("aria-label", `作品集第 ${number} 页，共 ${pageEntries.length} 页`);

    const placeholder = document.createElement("img");
    placeholder.className = "page-placeholder";
    placeholder.src = versionedAsset(
      `${PREVIEW_BASE_URL}page-${String(number).padStart(3, "0")}.webp`,
    );
    placeholder.alt = "";
    placeholder.loading = number <= 2 ? "eager" : "lazy";
    placeholder.decoding = "async";
    placeholder.draggable = false;
    placeholder.width = 960;
    placeholder.height = Math.round((960 * entry.height) / entry.width);
    if (number === 1) placeholder.fetchPriority = "high";
    placeholder.style.width = `${Math.round(fitWidth() * zoom)}px`;
    placeholder.style.aspectRatio = `${entry.width} / ${entry.height}`;
    placeholder.setAttribute("aria-hidden", "true");

    pageElement.append(canvas, placeholder);
    fragment.append(pageElement);
  });
  pagesContainer.append(fragment);

  pageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const number = Number(entry.target.dataset.page);
        renderPage(number);
      });
    },
    { root: scrollArea, rootMargin: "55% 0px", threshold: 0.01 },
  );
  pagesContainer.querySelectorAll(".pdf-page").forEach((page) => pageObserver.observe(page));
}

function getPageElement(number) {
  return pagesContainer.querySelector(`[data-page="${number}"]`);
}

function displayedSurface(pageElement) {
  return pageElement?.querySelector("canvas:not([hidden])") || pageElement?.querySelector(".page-placeholder");
}

function surfacePosition(surface) {
  let left = 0;
  let top = 0;
  let element = surface;
  while (element && element !== scrollArea) {
    left += element.offsetLeft;
    top += element.offsetTop;
    element = element.offsetParent;
  }
  return { left, top };
}

function captureViewportAnchor(clientX, clientY) {
  const pageElement = getPageElement(currentPage);
  const surface = displayedSurface(pageElement);
  if (!surface) return null;
  const position = surfacePosition(surface);
  const scrollRect = scrollArea.getBoundingClientRect();
  const viewportX = Number.isFinite(clientX) ? clientX - scrollRect.left : scrollArea.clientWidth / 2;
  const viewportY = Number.isFinite(clientY) ? clientY - scrollRect.top : scrollArea.clientHeight / 2;
  const documentX = scrollArea.scrollLeft + viewportX;
  const documentY = scrollArea.scrollTop + viewportY;
  return {
    page: currentPage,
    xRatio: Math.min(1, Math.max(0, (documentX - position.left) / Math.max(1, surface.offsetWidth))),
    yRatio: Math.min(1, Math.max(0, (documentY - position.top) / Math.max(1, surface.offsetHeight))),
    viewportX,
    viewportY,
  };
}

function restoreViewportAnchor(anchor) {
  if (!anchor) return;
  const surface = displayedSurface(getPageElement(anchor.page));
  if (!surface) return;
  const position = surfacePosition(surface);
  scrollArea.scrollTo({
    left: position.left + surface.offsetWidth * anchor.xRatio - anchor.viewportX,
    top: position.top + surface.offsetHeight * anchor.yRatio - anchor.viewportY,
    behavior: "auto",
  });
}

function stopRender(record) {
  record?.renderTask?.cancel();
  const destroyResult = record?.loadingTask?.destroy?.();
  if (destroyResult && typeof destroyResult.catch === "function") {
    destroyResult.catch(() => {});
  }
}

function cancelActiveRenders() {
  pageRenders.forEach((record, number) => {
    stopRender(record);
    getPageElement(number)?.classList.remove("is-rendering");
  });
  pageRenders.clear();
}

async function renderPage(number) {
  if (number < 1 || number > pageEntries.length) return;
  const pageElement = getPageElement(number);
  if (!pageElement) return;
  const version = layoutVersion;
  if (pageElement.dataset.renderVersion === String(version)) return;

  const existing = pageRenders.get(number);
  if (existing?.version === version) return existing.promise;
  stopRender(existing);

  const record = {
    version,
    loadingTask: null,
    document: null,
    renderTask: null,
    promise: null,
  };
  pageElement.classList.add("is-rendering");
  record.promise = (async () => {
    const entry = pageEntries[number - 1];
    record.loadingTask = pdfjsLib.getDocument({
      url: versionedAsset(`${PAGE_BASE_URL}${entry.file}`),
      cMapUrl: "./pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "./pdfjs/standard_fonts/",
      wasmUrl: "./pdfjs/wasm/",
    });
    if (number === 1 && !loadingPanel.hidden) {
      record.loadingTask.onProgress = ({ loaded, total }) => {
        if (!total) return;
        const percent = Math.min(100, Math.round((loaded / total) * 100));
        loadingProgress.style.width = `${percent}%`;
        loadingLabel.textContent = `正在打开作品集 · ${percent}%`;
      };
    }

    record.document = await record.loadingTask.promise;
    if (pageRenders.get(number) !== record) return;
    const page = await record.document.getPage(1);
    const naturalViewport = page.getViewport({ scale: 1 });
    const displayScale = (fitWidth() / naturalViewport.width) * zoom;
    const viewport = page.getViewport({ scale: displayScale });
    const pixelRatio = renderPixelRatio(viewport.width, viewport.height);
    const currentCanvas = pageElement.querySelector("canvas");
    const canvas = document.createElement("canvas");
    const placeholder = pageElement.querySelector(".page-placeholder");
    const context = canvas.getContext("2d", { alpha: false });

    canvas.setAttribute("aria-label", currentCanvas.getAttribute("aria-label"));
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    record.renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    });
    await record.renderTask.promise;
    if (pageRenders.get(number) !== record) return;
    currentCanvas.replaceWith(canvas);
    pageElement.dataset.renderVersion = String(version);
    placeholder.hidden = true;
    page.cleanup();
  })()
    .catch((error) => {
      if (error?.name !== "RenderingCancelledException") {
        console.error(`PDF page ${number} failed to render`, error);
      }
    })
    .finally(async () => {
      const destroyResult = record.loadingTask?.destroy?.();
      if (destroyResult && typeof destroyResult.catch === "function") {
        await destroyResult.catch(() => {});
      }
      if (pageRenders.get(number) === record) {
        pageElement.classList.remove("is-rendering");
        pageRenders.delete(number);
      }
    });

  pageRenders.set(number, record);
  return record.promise;
}

function renderNeighborhood(number) {
  const direction = number >= lastNeighborhoodPage ? 1 : -1;
  lastNeighborhoodPage = number;
  renderPage(number).then(() => {
    if (Math.abs(currentPage - number) > 1) return;
    renderPage(number + direction);
  });
}

function evictDistantPages(center, radius = 4) {
  pagesContainer.querySelectorAll(".pdf-page").forEach((pageElement) => {
    const number = Number(pageElement.dataset.page);
    if (Math.abs(number - center) <= radius) return;
    const activeRender = pageRenders.get(number);
    if (activeRender) {
      stopRender(activeRender);
      pageElement.classList.remove("is-rendering");
      pageRenders.delete(number);
    }
    const canvas = pageElement.querySelector("canvas");
    if (!canvas.hidden) {
      canvas.width = 1;
      canvas.height = 1;
      canvas.hidden = true;
      pageElement.querySelector(".page-placeholder").hidden = false;
      delete pageElement.dataset.renderVersion;
    }
  });
}

function jumpToPage(number, behavior = "smooth") {
  if (!pageEntries.length) return;
  currentPage = Math.min(pageEntries.length, Math.max(1, Number(number) || 1));
  updateControls();
  evictDistantPages(currentPage);
  renderNeighborhood(currentPage);
  const pageElement = getPageElement(currentPage);
  if (!pageElement) return;
  scrollArea.scrollTo({ top: Math.max(0, pageElement.offsetTop - 12), behavior });
}

function syncCurrentPage() {
  if (!pageEntries.length) return;
  const viewportCenter = scrollArea.scrollTop + scrollArea.clientHeight / 2;
  let nearest = currentPage;
  let nearestDistance = Number.POSITIVE_INFINITY;

  pagesContainer.querySelectorAll(".pdf-page").forEach((pageElement) => {
    const pageCenter = pageElement.offsetTop + pageElement.offsetHeight / 2;
    const distance = Math.abs(pageCenter - viewportCenter);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = Number(pageElement.dataset.page);
    }
  });

  if (nearest !== currentPage) {
    currentPage = nearest;
    updateControls();
  }
  evictDistantPages(currentPage);
  renderNeighborhood(currentPage);
}

function invalidateLayout() {
  layoutVersion += 1;
  cancelActiveRenders();
  updateContainerWidth();
  pagesContainer.querySelectorAll(".pdf-page").forEach((pageElement) => {
    delete pageElement.dataset.renderVersion;
    const number = Number(pageElement.dataset.page);
    const entry = pageEntries[number - 1];
    const displayWidth = fitWidth() * zoom;
    const displayHeight = (displayWidth * entry.height) / entry.width;
    const placeholder = pageElement.querySelector(".page-placeholder");
    placeholder.style.width = `${Math.round(displayWidth)}px`;
    const canvas = pageElement.querySelector("canvas");
    if (!canvas.hidden) {
      canvas.style.width = `${Math.round(displayWidth)}px`;
      canvas.style.height = `${Math.round(displayHeight)}px`;
    }
  });
}

function applyZoom(nextZoom, clientX, clientY) {
  const normalizedZoom = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom)) * 100) / 100;
  if (normalizedZoom === zoom) return;
  const anchor = captureViewportAnchor(clientX, clientY);
  zoom = normalizedZoom;
  invalidateLayout();
  updateControls();
  requestAnimationFrame(() => restoreViewportAnchor(anchor));
  clearTimeout(zoomRenderTimer);
  zoomRenderTimer = setTimeout(() => renderNeighborhood(currentPage), 120);
}

controls.previous.addEventListener("click", () => jumpToPage(currentPage - 1));
controls.next.addEventListener("click", () => jumpToPage(currentPage + 1));
controls.zoomOut.addEventListener("click", () => applyZoom(zoom - ZOOM_STEP));
controls.zoomIn.addEventListener("click", () => applyZoom(zoom + ZOOM_STEP));
controls.fitWidth.addEventListener("click", () => applyZoom(1));

pageInput.addEventListener("change", () => jumpToPage(pageInput.value));
pageInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  jumpToPage(pageInput.value);
  pageInput.blur();
});

scrollArea.addEventListener(
  "scroll",
  () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(syncCurrentPage, 90);
  },
  { passive: true },
);

scrollArea.addEventListener(
  "wheel",
  (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      applyZoom(zoom + direction * ZOOM_STEP, event.clientX, event.clientY);
      return;
    }
    if (event.shiftKey && scrollArea.scrollWidth > scrollArea.clientWidth) {
      event.preventDefault();
      scrollArea.scrollLeft += event.deltaY || event.deltaX;
    }
  },
  { passive: false },
);

scrollArea.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "mouse" || event.button !== 0 || !scrollArea.classList.contains("is-zoomed")) {
    return;
  }
  panState = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: scrollArea.scrollLeft,
    top: scrollArea.scrollTop,
  };
  scrollArea.setPointerCapture(event.pointerId);
  scrollArea.classList.add("is-panning");
  event.preventDefault();
});

scrollArea.addEventListener("pointermove", (event) => {
  if (!panState || event.pointerId !== panState.pointerId) return;
  scrollArea.scrollLeft = panState.left - (event.clientX - panState.x);
  scrollArea.scrollTop = panState.top - (event.clientY - panState.y);
});

function stopPanning(event) {
  if (!panState || event.pointerId !== panState.pointerId) return;
  if (scrollArea.hasPointerCapture(event.pointerId)) scrollArea.releasePointerCapture(event.pointerId);
  panState = null;
  scrollArea.classList.remove("is-panning");
}

scrollArea.addEventListener("pointerup", stopPanning);
scrollArea.addEventListener("pointercancel", stopPanning);

document.addEventListener("keydown", (event) => {
  if (!pageEntries.length || document.activeElement === pageInput) return;
  if (event.key === "PageUp") {
    event.preventDefault();
    jumpToPage(currentPage - 1);
  }
  if (event.key === "PageDown" || event.key === " ") {
    event.preventDefault();
    jumpToPage(currentPage + 1);
  }
  if (event.key === "Home") jumpToPage(1);
  if (event.key === "End") jumpToPage(pageEntries.length);
  if (event.key === "+" || event.key === "=") applyZoom(zoom + ZOOM_STEP);
  if (event.key === "-") applyZoom(zoom - ZOOM_STEP);
});

const resizeObserver = new ResizeObserver(() => {
  if (!pageEntries.length) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const anchor = captureViewportAnchor();
    invalidateLayout();
    renderNeighborhood(currentPage);
    requestAnimationFrame(() => restoreViewportAnchor(anchor));
  }, 180);
});
resizeObserver.observe(scrollArea);

async function initializeViewer() {
  try {
    const response = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Manifest request failed: ${response.status}`);
    const manifest = await response.json();
    if (!Array.isArray(manifest.pages) || !manifest.pages.length) {
      throw new Error("PDF page manifest is empty");
    }
    assetVersion = String(manifest.version || "1");
    pageEntries = manifest.pages;
    updateContainerWidth();
    createPageShells();
    pageInput.disabled = false;
    controls.zoomOut.disabled = false;
    controls.zoomIn.disabled = false;
    controls.fitWidth.disabled = false;
    updateControls();
    renderPage(1);
    await waitForFirstPreview();
    loadingPanel.hidden = true;
    scrollArea.setAttribute("aria-busy", "false");
    renderNeighborhood(1);
  } catch (error) {
    console.error("PDF viewer failed to initialize", error);
    loadingPanel.hidden = true;
    errorPanel.hidden = false;
    scrollArea.setAttribute("aria-busy", "false");
  }
}

initializeViewer();
