import "@fontsource-variable/manrope";
import "./style.css";
import "./viewport.css";
import "./release";

document.documentElement.classList.add("js");
const showcase = document.querySelector<HTMLElement>(".showcase")!;
const stage = document.querySelector<HTMLElement>(".device-stage")!;
const rig = document.querySelector<HTMLElement>(".device-rig")!;
const desktop = document.querySelector<HTMLImageElement>("#desktop-screen")!;
const phone = document.querySelector<HTMLImageElement>("#phone-screen")!;
const description = document.querySelector<HTMLElement>(".scene-description")!;
const buttons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-scene-step]"),
];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
const scenes = [
  {
    desktop: "desktop-approval.png",
    phone: "iphone-workspace.png",
    alt: "Modex Companion showing threads from the paired Mac",
    description:
      "Bring a project, choose an agent, and see each change as it happens.",
  },
  {
    desktop: "desktop-approval.png",
    phone: "iphone-approval.png",
    alt: "An iPhone approval card with Deny and Approve once controls",
    description:
      "When a decision needs you, review it on your iPhone. Approve once, or say no.",
  },
  {
    desktop: "desktop-complete.png",
    phone: "iphone-follow-up.png",
    alt: "An iPhone thread after an approval, with a follow-up message",
    description:
      "Send the next instruction from your phone. Your Mac keeps the work moving.",
  },
];
let current = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let manuallySelected = false;
function stop() {
  clearTimeout(timer);
  timer = undefined;
}
function autoplay() {
  stop();
  if (manuallySelected || document.hidden || reducedMotion.matches || details.open) return;
  timer = setTimeout(() => {
    show((current + 1) % scenes.length);
    autoplay();
  }, 4_000);
}
function show(index: number) {
  current = index;
  const scene = scenes[index]!;
  showcase.dataset.step = String(index);
  desktop.src = `/assets/${scene.desktop}`;
  desktop.alt =
    index === 2
      ? "Modex on Mac showing the approved change and its diff"
      : "Modex on Mac showing a coding thread and a request to approve a file change";
  phone.src = `/assets/${scene.phone}`;
  phone.alt = scene.alt;
  description.textContent = scene.description;
  buttons.forEach((button, i) =>
    button.setAttribute("aria-pressed", String(i === index)),
  );
}
buttons.forEach((button, index) =>
  button.addEventListener("click", () => {
    manuallySelected = true;
    stop();
    description.setAttribute("aria-live", "polite");
    show(index);
  }),
);
document.addEventListener("visibilitychange", autoplay);
let frame = 0;
function resetTilt() {
  cancelAnimationFrame(frame);
  rig.style.removeProperty("--tilt-x");
  rig.style.removeProperty("--tilt-y");
}
stage.addEventListener("pointermove", (event) => {
  if (
    reducedMotion.matches ||
    !finePointer.matches ||
    event.pointerType !== "mouse"
  )
    return;
  const bounds = stage.getBoundingClientRect();
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    rig.style.setProperty(
      "--tilt-y",
      `${((event.clientX - bounds.left) / bounds.width - 0.5) * 4}deg`,
    );
    rig.style.setProperty(
      "--tilt-x",
      `${-((event.clientY - bounds.top) / bounds.height - 0.5) * 3}deg`,
    );
  });
});
stage.addEventListener("pointerleave", resetTilt);
reducedMotion.addEventListener("change", () => {
  resetTilt();
  autoplay();
});
// Fetch only local screenshots; the carousel never contacts a model or pairing service.
for (const src of [
  "desktop-complete.png",
  "iphone-approval.png",
  "iphone-follow-up.png",
]) {
  const image = new Image();
  image.src = `/assets/${src}`;
}

// Keep supporting information available without extending the landing viewport.
const details = document.querySelector<HTMLDialogElement>("#details-dialog")!;
document.querySelector<HTMLButtonElement>("#close-details")!
  .addEventListener("click", () => details.close());
for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-details]')) {
  const target = document.getElementById(link.dataset.details!);
  if (!target || !details.contains(target)) continue;
  link.setAttribute("aria-haspopup", "dialog");
  link.setAttribute("aria-controls", details.id);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    stop();
    details.showModal();
    target.scrollIntoView({ block: "start", behavior: "instant" });
  });
}

details.addEventListener("close", autoplay);
autoplay();
