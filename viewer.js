import * as pdfjsLib from "./pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.min.mjs";

const PDF_URL = "portfolio.pdf";
const MAX_SCALE = 2.4;
const MIN_SCALE = 0.7;
const SCALE_STEP = 0.15;

const reader = document.querySelector("#reader");
const stage = document.querySelector("#reader-stage");
const singleCanvas = document.querySelector("#pdf-canvas");
const singleContext = singleCanvas.getContext("2d", { alpha: false });
const scrollView = document.querySelector("#pdf-scroll-view");
const loading = document.querySelector("#reader-loading");
const loadingLabel = document.querySelector("#loading-label");
const loadingProgress = document.querySelector("#loading-progress");
const errorPanel = document.querySelector("#reader-error");
const pageInput = document.querySelector("#page-input");
const pageCount = document.querySelector("#page-count");
const mobilePageStatus = document.querySelector("#mobile-page-status");
const zoomValue = document.querySelector("#zoom-value");

const controls = {
  previous: [document.querySelector("#prev-page"), document.querySelector("#mobile-prev")],
  next: [document.querySelector("#next-page"), document.querySelector("#mobile-next")],
  singleMode: document.querySelector("#single-mode"),
  scrollMode: document.querySelector("#scroll-mode"),
  zoomOut: document.querySelector("#zoom-out"),
  zoomIn: document.querySelector("#zoom-in"),
  fit: document.querySelector("#fit-page"),
  fullscreen: document.querySelector("#fullscreen"),
};

let pdfDocument = null;
let pageNumber = 1;
let viewMode = "single";
let scaleMultiplier = 1;
let singleRenderTask = null;
let singleRenderSequence = 0;
let resizeTimer = null;
let scrollSyncTimer = null;
let touchStart = null;
let scrollPagesReady = false;
let scrollObserver = null;
let scrollLayoutVersion = 0;
const scrollRenderPromises = new Map();

function setDisabled(buttons, disabled) {
  const list = Array.isArray(buttons) ? buttons : [buttons];
  list.forEach((button) => {
    button.disabled = disabled;
  });
}

function updateControls() {
  if (!pdfDocument) return;
  const total = pdfDocument.numPages;
  pageInput.value = String(pageNumber);
  pageInput.max = String(total);
  pageCount.textContent = String(total);
  mobilePageStatus.textContent = `第 ${pageNumber} / ${total} 页`;
  singleCanvas.setAttribute("aria-label", `作品集第 ${pageNumber} 页，共 ${total} 页`);
  setDisabled(controls.previous, pageNumber <= 1);
  setDisabled(controls.next, pageNumber >= total);

  const isSingle = viewMode === "single";
  controls.singleMode.classList.toggle("is-active", isSingle);
  controls.scrollMode.classList.toggle("is-active", !isSingle);
  controls.singleMode.setAttribute("aria-pressed", String(isSingle));
  controls.scrollMode.setAttribute("aria-pressed", String(!isSingle));
  controls.zoomOut.disabled = !isSingle || scaleMultiplier <= MIN_SCALE;
  controls.zoomIn.disabled = !isSingle || scaleMultiplier >= MAX_SCALE;
  controls.fit.disabled = !isSingle;
  zoomValue.textContent = isSingle
    ? scaleMultiplier === 1
      ? "适合页面"
      : `${Math.round(scaleMultiplier * 100)}%`
    : "自动停靠";
}

function getStageAvailableSize() {
  const styles = window.getComputedStyle(stage);
  const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  return {
    width: Math.max(240, stage.clientWidth - horizontalPadding),
    height: Math.max(320, stage.clientHeight - verticalPadding),
  };
}

async function renderSinglePage(number, { resetScroll = true } = {}) {
  if (!pdfDocument || viewMode !== "single") return;
  const sequence = ++singleRenderSequence;

  if (singleRenderTask) {
    singleRenderTask.cancel();
    singleRenderTask = null;
  }

  const page = await pdfDocument.getPage(number);
  if (sequence !== singleRenderSequence || viewMode !== "single") return;

  const naturalViewport = page.getViewport({ scale: 1 });
  const available = getStageAvailableSize();
  const isMobile = window.matchMedia("(max-width: 720px)").matches;
  const fitScale = isMobile
    ? available.width / naturalViewport.width
    : Math.min(available.width / naturalViewport.width, available.height / naturalViewport.height);
  const viewport = page.getViewport({ scale: fitScale * scaleMultiplier });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  singleCanvas.width = Math.floor(viewport.width * pixelRatio);
  singleCanvas.height = Math.floor(viewport.height * pixelRatio);
  singleCanvas.style.width = `${Math.floor(viewport.width)}px`;
  singleCanvas.style.height = `${Math.floor(viewport.height)}px`;
  singleCanvas.hidden = false;

  singleContext.setTransform(1, 0, 0, 1, 0, 0);
  singleContext.fillStyle = "#ffffff";
  singleContext.fillRect(0, 0, singleCanvas.width, singleCanvas.height);

  singleRenderTask = page.render({
    canvasContext: singleContext,
    viewport,
    transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
  });

  try {
    await singleRenderTask.promise;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") throw error;
    return;
  } finally {
    singleRenderTask = null;
  }

  if (sequence !== singleRenderSequence || viewMode !== "single") return;
  if (resetScroll) stage.scrollTo({ top: 0, left: 0, behavior: "auto" });
  updateControls();
  page.cleanup();
}

function createScrollPages() {
  if (scrollPagesReady || !pdfDocument) return;
  const fragment = document.createDocumentFragment();

  for (let number = 1; number <= pdfDocument.numPages; number += 1) {
    const pageShell = document.createElement("section");
    pageShell.className = "scroll-page";
    pageShell.dataset.page = String(number);
    pageShell.setAttribute("aria-label", `第 ${number} 页`);

    const pageCanvas = document.createElement("canvas");
    pageCanvas.className = "scroll-page-canvas";
    pageCanvas.hidden = true;
    pageCanvas.setAttribute("aria-label", `作品集第 ${number} 页，共 ${pdfDocument.numPages} 页`);

    const placeholder = document.createElement("span");
    placeholder.className = "scroll-page-placeholder";
    placeholder.textContent = `第 ${number} 页`;
    placeholder.setAttribute("aria-hidden", "true");

    pageShell.append(pageCanvas, placeholder);
    fragment.append(pageShell);
  }

  scrollView.append(fragment);
  scrollPagesReady = true;
  scrollObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const number = Number(entry.target.dataset.page);
        renderScrollNeighborhood(number);
      });
    },
    { root: stage, rootMargin: "110% 0px", threshold: 0.01 },
  );
  scrollView.querySelectorAll(".scroll-page").forEach((page) => scrollObserver.observe(page));
}

function updateScrollSlotHeight() {
  scrollView.style.setProperty("--scroll-slot-height", `${Math.max(360, stage.clientHeight)}px`);
}

async function renderScrollPage(number) {
  if (!pdfDocument || !scrollPagesReady || number < 1 || number > pdfDocument.numPages) return;
  const shell = scrollView.querySelector(`[data-page="${number}"]`);
  if (!shell) return;
  const renderVersion = String(scrollLayoutVersion);
  if (shell.dataset.renderVersion === renderVersion) return;
  if (scrollRenderPromises.has(number)) return scrollRenderPromises.get(number);

  const promise = (async () => {
    const page = await pdfDocument.getPage(number);
    const canvas = shell.querySelector("canvas");
    const placeholder = shell.querySelector(".scroll-page-placeholder");
    const styles = window.getComputedStyle(shell);
    const availableWidth = Math.max(
      240,
      shell.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight),
    );
    const availableHeight = Math.max(
      300,
      shell.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom),
    );
    const naturalViewport = page.getViewport({ scale: 1 });
    const fitScale = Math.min(
      availableWidth / naturalViewport.width,
      availableHeight / naturalViewport.height,
    );
    const viewport = page.getViewport({ scale: fitScale });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.hidden = false;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    });
    await renderTask.promise;
    shell.dataset.renderVersion = renderVersion;
    placeholder.hidden = true;
    page.cleanup();
  })()
    .catch((error) => {
      if (error?.name !== "RenderingCancelledException") console.error(`Page ${number} failed to render`, error);
    })
    .finally(() => scrollRenderPromises.delete(number));

  scrollRenderPromises.set(number, promise);
  return promise;
}

function renderScrollNeighborhood(number) {
  [number - 1, number, number + 1].forEach((page) => renderScrollPage(page));
}

function getScrollPage(number) {
  return scrollView.querySelector(`[data-page="${number}"]`);
}

function scrollToPage(number, behavior = "smooth") {
  const shell = getScrollPage(number);
  if (!shell) return;
  renderScrollNeighborhood(number);
  stage.scrollTo({ top: shell.offsetTop, left: 0, behavior });
}

function syncPageFromScroll() {
  if (viewMode !== "scroll" || !scrollPagesReady) return;
  const stageCenter = stage.scrollTop + stage.clientHeight / 2;
  let closestPage = pageNumber;
  let closestDistance = Number.POSITIVE_INFINITY;

  scrollView.querySelectorAll(".scroll-page").forEach((shell) => {
    const shellCenter = shell.offsetTop + shell.offsetHeight / 2;
    const distance = Math.abs(stageCenter - shellCenter);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestPage = Number(shell.dataset.page);
    }
  });

  if (closestPage !== pageNumber) {
    pageNumber = closestPage;
    updateControls();
  }
  renderScrollNeighborhood(closestPage);
}

async function setViewMode(nextMode) {
  if (!pdfDocument || nextMode === viewMode) return;
  viewMode = nextMode;
  reader.dataset.mode = viewMode;
  updateControls();

  if (viewMode === "scroll") {
    singleRenderSequence += 1;
    if (singleRenderTask) singleRenderTask.cancel();
    singleCanvas.hidden = true;
    scrollView.hidden = false;
    createScrollPages();
    updateScrollSlotHeight();
    scrollLayoutVersion += 1;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    scrollToPage(pageNumber, "auto");
  } else {
    scrollView.hidden = true;
    singleCanvas.hidden = false;
    stage.scrollTo({ top: 0, left: 0, behavior: "auto" });
    await renderSinglePage(pageNumber, { resetScroll: false });
  }
}

async function goToPage(nextPage) {
  if (!pdfDocument) return;
  const target = Math.min(pdfDocument.numPages, Math.max(1, Number(nextPage) || 1));
  pageNumber = target;
  updateControls();
  if (viewMode === "scroll") {
    scrollToPage(pageNumber);
  } else {
    await renderSinglePage(pageNumber);
  }
}

async function changeScale(delta) {
  if (viewMode !== "single") return;
  scaleMultiplier = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scaleMultiplier + delta));
  scaleMultiplier = Math.round(scaleMultiplier * 100) / 100;
  updateControls();
  await renderSinglePage(pageNumber, { resetScroll: false });
}

controls.previous.forEach((button) => button.addEventListener("click", () => goToPage(pageNumber - 1)));
controls.next.forEach((button) => button.addEventListener("click", () => goToPage(pageNumber + 1)));
controls.singleMode.addEventListener("click", () => setViewMode("single"));
controls.scrollMode.addEventListener("click", () => setViewMode("scroll"));
controls.zoomOut.addEventListener("click", () => changeScale(-SCALE_STEP));
controls.zoomIn.addEventListener("click", () => changeScale(SCALE_STEP));
controls.fit.addEventListener("click", async () => {
  scaleMultiplier = 1;
  updateControls();
  await renderSinglePage(pageNumber);
});

pageInput.addEventListener("change", () => goToPage(pageInput.value));
pageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    goToPage(pageInput.value);
    pageInput.blur();
  }
});

controls.fullscreen.addEventListener("click", async () => {
  if (!document.fullscreenElement) {
    await reader.requestFullscreen?.();
  } else {
    await document.exitFullscreen?.();
  }
});

document.addEventListener("fullscreenchange", () => {
  controls.fullscreen.textContent = document.fullscreenElement ? "退出全屏" : "全屏";
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(handleResize, 140);
});

document.addEventListener("keydown", (event) => {
  if (!pdfDocument || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (event.key === "ArrowLeft" || event.key === "PageUp") goToPage(pageNumber - 1);
  if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
    event.preventDefault();
    goToPage(pageNumber + 1);
  }
  if (event.key === "Home") goToPage(1);
  if (event.key === "End") goToPage(pdfDocument.numPages);
  if (event.key === "+" || event.key === "=") changeScale(SCALE_STEP);
  if (event.key === "-") changeScale(-SCALE_STEP);
});

stage.addEventListener(
  "touchstart",
  (event) => {
    const touch = event.changedTouches[0];
    touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  },
  { passive: true },
);

stage.addEventListener(
  "touchend",
  (event) => {
    if (!touchStart) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    const elapsed = Date.now() - touchStart.time;
    touchStart = null;
    if (elapsed < 700 && Math.abs(deltaX) > 55 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25) {
      goToPage(deltaX < 0 ? pageNumber + 1 : pageNumber - 1);
    }
  },
  { passive: true },
);

stage.addEventListener(
  "scroll",
  () => {
    if (viewMode !== "scroll") return;
    clearTimeout(scrollSyncTimer);
    scrollSyncTimer = setTimeout(syncPageFromScroll, 110);
  },
  { passive: true },
);

function handleResize() {
  if (!pdfDocument) return;
  if (viewMode === "single") {
    renderSinglePage(pageNumber, { resetScroll: false });
    return;
  }
  updateScrollSlotHeight();
  scrollLayoutVersion += 1;
  scrollView.querySelectorAll(".scroll-page").forEach((shell) => {
    delete shell.dataset.renderVersion;
  });
  renderScrollNeighborhood(pageNumber);
  requestAnimationFrame(() => scrollToPage(pageNumber, "auto"));
}

const resizeObserver = new ResizeObserver(() => {
  if (!pdfDocument) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(handleResize, 180);
});
resizeObserver.observe(stage);

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
      loadingLabel.textContent = `正在加载作品集 · ${percent}%`;
    };

    pdfDocument = await loadingTask.promise;
    pageInput.disabled = false;
    controls.zoomOut.disabled = false;
    controls.zoomIn.disabled = false;
    controls.fit.disabled = false;
    updateControls();
    await renderSinglePage(pageNumber);
    loading.hidden = true;
    stage.setAttribute("aria-busy", "false");
  } catch (error) {
    console.error("PDF viewer failed to initialize", error);
    loading.hidden = true;
    errorPanel.hidden = false;
    stage.setAttribute("aria-busy", "false");
  }
}

initializeViewer();
