import "@fontsource-variable/manrope";
import "./style.css";

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
const play = document.querySelector<HTMLButtonElement>("#play-story")!;
const presentation = document.querySelector<HTMLDialogElement>("#walkthrough-dialog")!;
const presentationContent = document.querySelector<HTMLElement>("#walkthrough-content")!;
const closePresentation = document.querySelector<HTMLButtonElement>("#close-walkthrough")!;
let placeholder: HTMLDivElement | undefined;
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
function updatePlaybackControl() {
  const playing = timer !== undefined;
  play.setAttribute("aria-pressed", String(playing));
  play.querySelector(".play-symbol")!.textContent = playing ? "Ⅱ" : "▶";
  play.querySelector(".play-label")!.textContent = playing
    ? "Pause walkthrough"
    : presentation.open && current === scenes.length - 1
      ? "Replay walkthrough"
      : presentation.open && current > 0
        ? "Resume walkthrough"
        : "Play walkthrough";
}
function stop() {
  clearTimeout(timer);
  timer = undefined;
  updatePlaybackControl();
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
  updatePlaybackControl();
}
buttons.forEach((button, index) =>
  button.addEventListener("click", () => {
    stop();
    show(index);
  }),
);
play.addEventListener("click", () => {
  if (timer !== undefined) {
    stop();
    return;
  }
  if (!presentation.open) {
    // Move the existing interactive stage so screenshots, controls and IDs stay unique.
    placeholder = document.createElement("div");
    placeholder.style.height = `${showcase.getBoundingClientRect().height}px`;
    showcase.replaceWith(placeholder);
    presentationContent.append(showcase);
    document.documentElement.classList.add("walkthrough-open");
    play.removeAttribute("aria-haspopup");
    resetTilt();
    presentation.showModal();
    show(0);
  } else if (current === scenes.length - 1) {
    show(0);
  }
  const advance = () => {
    if (current === scenes.length - 1) {
      stop();
      return;
    }
    show(current + 1);
    timer = setTimeout(advance, 4_000);
  };
  timer = setTimeout(advance, 4_000);
  updatePlaybackControl();
});
closePresentation.addEventListener("click", () => presentation.close());
presentation.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const controls = [...presentation.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]
    .filter((button) => button.getClientRects().length > 0);
  const first = controls[0], last = controls.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
presentation.addEventListener("close", () => {
  stop();
  placeholder?.replaceWith(showcase);
  placeholder = undefined;
  document.documentElement.classList.remove("walkthrough-open");
  play.setAttribute("aria-haspopup", "dialog");
  resetTilt();
  play.focus({ preventScroll: true });
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
});
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
reducedMotion.addEventListener("change", resetTilt);
// Fetch only local screenshots; the walkthrough never contacts a model or pairing service.
for (const src of [
  "desktop-complete.png",
  "iphone-approval.png",
  "iphone-follow-up.png",
]) {
  const image = new Image();
  image.src = `/assets/${src}`;
}
