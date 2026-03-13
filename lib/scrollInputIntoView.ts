export function enableMobileInputScroll() {
  if (typeof window === "undefined") return;

  const inputs = document.querySelectorAll("input, textarea, select");

  inputs.forEach((el) => {
    el.addEventListener("focus", () => {
      setTimeout(() => {
        (el as HTMLElement).scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 250);
    });
  });
}