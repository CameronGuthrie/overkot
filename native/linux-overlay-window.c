/* Apply fullscreen overlay hints to an existing X11 window, without activation. */
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <ctype.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int x_error = 0;

static int record_x_error(Display *display, XErrorEvent *event) {
  (void)display;
  x_error = event->error_code;
  return 0;
}

static int fail(const char *message) {
  fprintf(stderr, "[overlay-window] %s\n", message);
  return 1;
}

static int parse_window(const char *text, Window *window) {
  const char *digits = text;
  if (text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) digits += 2;
  size_t length = strlen(digits);
  if (!length || length > 8) return 0;
  for (size_t i = 0; i < length; ++i) {
    if (!isxdigit((unsigned char)digits[i])) return 0;
  }
  errno = 0;
  char *end = NULL;
  unsigned long value = strtoul(digits, &end, 16);
  if (errno || *end || !value || value > UINT32_MAX) return 0;
  *window = (Window)value;
  return 1;
}

int main(int argc, char **argv) {
  Window window;
  if (argc != 2 || !parse_window(argv[1], &window)) {
    return fail("Expected one nonzero hexadecimal X11 window ID.");
  }
  Display *display = XOpenDisplay(NULL);
  if (!display) return fail("Cannot open the X11 display.");
  XSetErrorHandler(record_x_error);

  XWindowAttributes attributes;
  Status exists = XGetWindowAttributes(display, window, &attributes);
  XSync(display, False);
  if (!exists || x_error || window == attributes.root) {
    XCloseDisplay(display);
    return fail("The target is missing or is an X11 root window.");
  }

  char *names[] = {
    "_NET_WM_WINDOW_TYPE",
    "_KDE_NET_WM_WINDOW_TYPE_CRITICAL_NOTIFICATION",
    "_NET_WM_WINDOW_TYPE_NOTIFICATION",
    "_NET_WM_WINDOW_TYPE_DOCK",
    "_NET_WM_BYPASS_COMPOSITOR",
  };
  Atom atoms[5];
  Status interned = XInternAtoms(display, names, 5, False, atoms);
  XSync(display, False);
  if (!interned || x_error) {
    XCloseDisplay(display);
    return fail("Cannot resolve X11 overlay hints.");
  }

  /* KWin puts ordinary docks and notifications below active fullscreen
   * windows. Its critical-notification layer remains above them. Other window
   * managers select the first recognized standard fallback in this list. */
  Atom types[] = {atoms[1], atoms[2], atoms[3]};
  unsigned long compositor = 2;
  XChangeProperty(display, window, atoms[0], XA_ATOM, 32, PropModeReplace,
                  (unsigned char *)types, 3);
  XChangeProperty(display, window, atoms[4], XA_CARDINAL, 32, PropModeReplace,
                  (unsigned char *)&compositor, 1);
  XSync(display, False);
  int failed = x_error;
  XCloseDisplay(display);
  return failed ? fail("The X11 overlay hints could not be applied.") : 0;
}
