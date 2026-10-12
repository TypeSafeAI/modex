import "@fontsource-variable/manrope";
import "./style.css";
import "./viewport.css";
import "./release";

const showcase = document.querySelector<HTMLElement>(".showcase")!;
const image = document.querySelector<HTMLImageElement>("#desktop-screen")!;
const screenshotLink = image.closest<HTMLAnchorElement>("a")!;
const controls = document.querySelector<HTMLElement>(".step-buttons")!;
const scenes = [
  {
    kicker: "01 / THE REQUEST",
    title: "Give the task a home.",
    description:
      "Open a project and start a thread. Your request, the agent’s work, and its changes stay together.",
    example:
      "“Add a CONTRIBUTING.md with the three-step workflow: install, test, PR.”",
    outcome: "A real demo task, ready to follow.",
    image: "workflow-approval.png",
    alt: "Modex follows the contributor-guide request, reads the project and prepares a patch",
  },
  {
    kicker: "02 / THE PROPOSED CHANGE",
    title: "See what you’re approving.",
    description:
      "Read the proposed patch in the thread. Choose whether to approve this action or deny it before the work continues.",
    example:
      "One new file. The install, test, and pull-request steps, visible before the edit.",
    outcome: "The demo pauses at a real approval request.",
    image: "workflow-approval.png",
    alt: "A proposed CONTRIBUTING.md patch with Approve, Always and Deny buttons in Modex",
  },
  {
    kicker: "03 / THE RESULT",
    title: "Keep the change in view.",
    description:
      "After approval, inspect the diff beside the conversation. The result and the next instruction stay in the same place.",
    example:
      "CONTRIBUTING.md added: five lines, with a visible diff and an approval receipt.",
    outcome: "Approved. Changed. Ready for your next instruction.",
    image: "workflow-complete.png",
    alt: "The approved contributor guide, its five added lines, and the completion message in Modex",
  },
];
const buttons = [
  ...controls.querySelectorAll<HTMLButtonElement>("[data-scene-step]"),
];
function show(index: number) {
  const scene = scenes[index];
  if (!scene) return;
  showcase.dataset.step = String(index);
  image.src = `/assets/${scene.image}`;
  image.alt = scene.alt;
  screenshotLink.href = image.src;
  screenshotLink.dataset.imageTitle = scene.title;
  for (const [className, text] of Object.entries({
    "scene-kicker": scene.kicker,
    "scene-title": scene.title,
    "scene-description": scene.description,
    "scene-example": scene.example,
    "scene-outcome": scene.outcome,
  })) {
    showcase.querySelector<HTMLElement>(`.${className}`)!.textContent = text;
  }
  buttons.forEach((button, i) =>
    button.setAttribute("aria-pressed", String(i === index)),
  );
}
buttons.forEach((button, index) =>
  button.addEventListener("click", () => show(index)),
);
controls.hidden = false;
// Deliberate selection only: no timer, autoplay or pointer-driven movement.
const dialog = document.querySelector<HTMLDialogElement>("#image-dialog")!;
const expanded = document.querySelector<HTMLImageElement>("#expanded-image")!;
for (const link of document.querySelectorAll<HTMLAnchorElement>(
  "[data-open-image]",
)) {
  link.setAttribute("aria-haspopup", "dialog");
  link.setAttribute("aria-controls", dialog.id);
  link.addEventListener("click", async (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    const thumbnail = link.querySelector("img")!;
    const crop = link.getBoundingClientRect();
    const source = thumbnail.getBoundingClientRect();
    const cropX = Math.max(0, (crop.left - source.left) / source.width);
    const cropY = Math.max(0, (crop.top - source.top) / source.height);
    dialog.dataset.format = link.closest(".companion-visual")
      ? "portrait"
      : "desktop";
    expanded.src = link.href;
    expanded.alt = link.querySelector("img")?.alt ?? "Modex product screenshot";
    document.querySelector<HTMLElement>("#image-title")!.textContent =
      link.dataset.imageTitle ?? "Inside Modex";
    document.querySelector<HTMLAnchorElement>("#original-image")!.href =
      link.href;
    dialog.showModal();
    try {
      await expanded.decode();
      if (!dialog.open || expanded.src !== link.href) return;
      dialog.querySelector<HTMLElement>(".image-viewport")!.scrollTo({
        left: cropX * expanded.clientWidth,
        top: cropY * expanded.clientHeight,
        behavior: "instant",
      });
    } catch {
      // The original-image link remains available if decoding fails.
    }
  });
}
document
  .querySelector<HTMLButtonElement>("#close-image")!
  .addEventListener("click", () => dialog.close());
