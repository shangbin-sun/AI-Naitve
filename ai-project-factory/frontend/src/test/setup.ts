import "@ant-design/v5-patch-for-react-19";
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
Object.defineProperty(window, "matchMedia", {
  value: vi
    .fn()
    .mockImplementation((query) => ({
      matches: false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
});
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserver);
Element.prototype.scrollIntoView = vi.fn();
const original = window.getComputedStyle;
window.getComputedStyle = (element) => original(element);
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
});

window.scrollTo = vi.fn();

Element.prototype.scrollTo = vi.fn();
