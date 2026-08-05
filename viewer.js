import * as pdfjsLib from "./pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.min.mjs";

const PDF_URL = "portfolio.pdf";
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.15;

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

let pdfDocument = null;
let currentPage = 1;
let zoom = 1;
let firstPageRatio = 16 / 10;
let layoutVersion = 1;
let pageObserver = null;
let resizeTimer = null;
let scrollTimer = null;
const pageRenders = new Map();

function pageGutter() {
  return window.matchMedia("(max-width: 600px)").matches ? 16 : 48;
}

function fitWidth() {
  return Math.max(240, scrollArea.clientWidth - pageGutter());
}

function updateContainerWidth() {
  const width = Math.max(scrollArea.clientWidth, fitWidth() * zoom + pageGutter());
  pagesContainer.style.width = `${Math.round(width)}px`;
}

function updateControls() {
  if (!pdfDocument) return;
  const total = pdfDocument.numPages;
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

function createPageShells() {
  const fragment = document.createDocumentFragment();
  for (let number = 1; number <= pdfDocument.numPages; number += 1) {
    const pageElement = document.createElement("article");
    pageElement.className = "pdf-page";
    pageElement.dataset.page = String(number);
    pageElement.setAttribute("aria-label", `第 ${number} 页`);

    const canvas = document.createElement("canvas");
    canvas.hidden = true;
    canvas.setAttribute("aria-label", `作品集第 ${number} 页，共 ${pdfDocument.numPages} 页`);

    const placeholder = document.createElement("span");
    placeholder.className = "page-placeholder";
    placeholder.textContent = `第 ${number} 页`;
    placeholder.style.width = `${Math.round(fitWidth() * zoom)}px`;
    placeholder.style.aspectRatio = String(firstPageRatio);
    placeholder.setAttribute("aria-hidden", "true");

    pageElement.append(canvas, placeholder);
    fragment.append(pageElement);
  }
  pagesContainer.append(fragment);

  pageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const number = Number(entry.target.dataset.page);
        renderNeighborhood(number);
      });
    },
    { root: scrollArea, rootMargin: "130% 0px", threshold: 0.01 },
  );
  pagesContainer.querySelectorAll(".pdf-page").forEach((page) => pageObserver.observe(page));
}

function getPageElement(number) {
  return pagesContainer.querySelector(`[data-page="${number}"]`);
}

async function renderPage(number) {
  if (!pdfDocument || number < 1 || number > pdfDocument.numPages) return;
  const pageElement = getPageElement(number);
  if (!pageElement) return;
  const version = layoutVersion;
  if (pageElement.dataset.renderVersion === String(version)) return;

  const existing = pageRenders.get(number);
  if (existing?.version === version) return existing.promise;
  existing?.task?.cancel();

  const record = { version, task: null, promise: null };
  record.promise = (async () => {
    const page = await pdfDocument.getPage(number);
    if (pageRenders.get(number) !== record) return;

    const naturalViewport = page.getViewport({ scale: 1 });
    const displayScale = (fitWidth() / naturalViewport.width) * zoom;
    const viewport = page.getViewport({ scale: displayScale });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = pageElement.querySelector("canvas");
    const placeholder = pageElement.querySelector(".page-placeholder");
    const context = canvas.getContext("2d", { alpha: false });

    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.hidden = false;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    record.task = page.render({
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    });
    await record.task.promise;
    if (pageRenders.get(number) !== record) return;
    pageElement.dataset.renderVersion = String(version);
    placeholder.hidden = true;
    page.cleanup();
  })()
    .catch((error) => {
      if (error?.name !== "RenderingCancelledException") {
        console.error(`PDF page ${number} failed to render`, error);
      }
    })
    .finally(() => {
      if (pageRenders.get(number) === record) pageRenders.delete(number);
    });

  pageRenders.set(number, record);
  return record.promise;
}

function renderNeighborhood(number) {
  [number - 2, number - 1, number, number + 1, number + 2].forEach((page) => renderPage(page));
}

function jumpToPage(number, behavior = "smooth") {
  if (!pdfDocument) return;
  currentPage = Math.min(pdfDocument.numPages, Math.max(1, Number(number) || 1));
  updateControls();
  renderNeighborhood(currentPage);
  const pageElement = getPageElement(currentPage);
  if (!pageElement) return;
  scrollArea.scrollTo({ top: Math.max(0, pageElement.offsetTop - 12), behavior });
}

function syncCurrentPage() {
  if (!pdfDocument) return;
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
  renderNeighborhood(currentPage);
}

function applyZoom(nextZoom) {
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  zoom = Math.round(zoom * 100) / 100;
  layoutVersion += 1;
  updateContainerWidth();
  pagesContainer.querySelectorAll(".pdf-page").forEach((pageElement) => {
    delete pageElement.dataset.renderVersion;
    const placeholder = pageElement.querySelector(".page-placeholder");
    placeholder.style.width = `${Math.round(fitWidth() * zoom)}px`;
  });
  updateControls();
  renderNeighborhood(currentPage);
  requestAnimationFrame(() => jumpToPage(currentPage, "auto"));
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

document.addEventListener("keydown", (event) => {
  if (!pdfDocument || document.activeElement === pageInput) return;
  if (event.key === "PageUp") {
    event.preventDefault();
    jumpToPage(currentPage - 1);
  }
  if (event.key === "PageDown" || event.key === " ") {
    event.preventDefault();
    jumpToPage(currentPage + 1);
  }
  if (event.key === "Home") jumpToPage(1);
  if (event.key === "End") jumpToPage(pdfDocument.numPages);
  if (event.key === "+" || event.key === "=") applyZoom(zoom + ZOOM_STEP);
  if (event.key === "-") applyZoom(zoom - ZOOM_STEP);
});

const resizeObserver = new ResizeObserver(() => {
  if (!pdfDocument) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layoutVersion += 1;
    updateContainerWidth();
    pagesContainer.querySelectorAll(".pdf-page").forEach((pageElement) => {
      delete pageElement.dataset.renderVersion;
      const placeholder = pageElement.querySelector(".page-placeholder");
      placeholder.style.width = `${Math.round(fitWidth() * zoom)}px`;
    });
    renderNeighborhood(currentPage);
    requestAnimationFrame(() => jumpToPage(currentPage, "auto"));
  }, 180);
});
resizeObserver.observe(scrollArea);

async function initializeViewer() {
  try {
    const loadingTask = pdfjsLib.getDocument({
      url: PDF_URL,
      cMapUrl: "./pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "./pdfjs/standard_fonts/",
      wasmUrl: "./pdfjs/wasm/",
    });

    loadingTask.onProgress = ({ loaded, total }) => {
      if (!total) return;
      const percent = Math.min(100, Math.round((loaded / total) * 100));
      loadingProgress.style.width = `${percent}%`;
      loadingLabel.textContent = `正在打开 PDF · ${percent}%`;
    };

    pdfDocument = await loadingTask.promise;
    const firstPage = await pdfDocument.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    firstPageRatio = firstViewport.width / firstViewport.height;
    updateContainerWidth();
    createPageShells();
    pageInput.disabled = false;
    controls.zoomOut.disabled = false;
    controls.zoomIn.disabled = false;
    controls.fitWidth.disabled = false;
    updateControls();
    await renderPage(1);
    renderNeighborhood(1);
    loadingPanel.hidden = true;
    scrollArea.setAttribute("aria-busy", "false");
  } catch (error) {
    console.error("PDF viewer failed to initialize", error);
    loadingPanel.hidden = true;
    errorPanel.hidden = false;
    scrollArea.setAttribute("aria-busy", "false");
  }
}

initializeViewer();
