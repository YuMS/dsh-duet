// Hidden native fixture: validate the system-facing window role, not a source string.
#import "../../desktop/src-tauri/src/macos_window.m"
#include <assert.h>
@interface FloatingFixtureWindow : NSWindow @end
@implementation FloatingFixtureWindow @end
static FloatingFixtureWindow *makeWindow(void) {
    FloatingFixtureWindow *window = [[FloatingFixtureWindow alloc]
        initWithContentRect:NSMakeRect(200, 100, 380, 1050)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    return window;
}
int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    FloatingFixtureWindow *companion = makeWindow(), *ordinary = makeWindow();
    Class original = object_getClass(companion);
    NSString *ordinaryRole = ordinary.accessibilitySubrole;
    assert(duet_install_window_geometry((__bridge void *)companion) == 1);
    assert(object_getClass(companion) == original);
    assert([companion.accessibilityRole isEqualToString:NSAccessibilityWindowRole]);
    assert([companion.accessibilitySubrole isEqualToString:NSAccessibilityFloatingWindowSubrole]);
    assert(ordinary.accessibilitySubrole == ordinaryRole || [ordinary.accessibilitySubrole isEqualToString:ordinaryRole]);
    NSRect desired = NSMakeRect(550, -250, 380, 1190);
    [companion setFrame:desired display:NO];
    assert(NSEqualRects(companion.frame, desired));
    assert([companion.accessibilitySubrole isEqualToString:NSAccessibilityFloatingWindowSubrole]);
    [companion close]; [ordinary close];
    puts("Native floating-window role, class identity, intentional reposition/resize and ordinary-window isolation passed");
} return 0; }
