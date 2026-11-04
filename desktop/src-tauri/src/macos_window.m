#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <stdlib.h>
#import <unistd.h>

static NSRunningApplication *duetOwnerApplication;
static BOOL duetIsOwner(NSRunningApplication *app) {
    if (!app || app.processIdentifier == getpid() || app.terminated) return NO;
    NSString *name = [(app.bundleIdentifier ?: app.localizedName ?: @"") lowercaseString];
    NSString *kind = [NSString stringWithUTF8String:getenv("DUET_AVATAR_OWNER_KIND") ?: "browser"];
    NSArray<NSString *> *allowed;
    if ([kind isEqualToString:@"desktop"]) allowed=@[@"dsh", @"deepseek"];
    else if ([kind isEqualToString:@"chrome"]) allowed=@[@"chrome", @"chromium", @"brave", @"thebrowser.browser"];
    else if ([kind isEqualToString:@"edge"]) allowed=@[@"edgemac"];
    else if ([kind isEqualToString:@"firefox"]) allowed=@[@"firefox"];
    else if ([kind isEqualToString:@"safari"]) allowed=@[@"safari"];
    else allowed=@[@"chrome", @"chromium", @"brave", @"thebrowser.browser", @"edgemac", @"firefox", @"safari"];
    for (NSString *part in allowed) if ([name containsString:part]) return YES;
    return NO;
}
int duet_remember_owner(void) {
    if (![NSThread isMainThread]) return 0;
    NSRunningApplication *app=NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!duetIsOwner(app)) return 0;
    duetOwnerApplication=app;return 1;
}
int duet_focus_owner(void) {
    if (![NSThread isMainThread] || !duetIsOwner(duetOwnerApplication)) return 0;
    [duetOwnerApplication unhide];
    return [duetOwnerApplication activateWithOptions:NSApplicationActivateIgnoringOtherApps] ? 1 : 0;
}

static char duetFreePlacementKey;
static Class duetWindowClass;
static IMP duetOriginalConstrain;

// Keep the initialized window's class intact: changing its isa invalidates
// AppKit's dynamic-property setup on newer macOS versions. Override only the
// helper's existing window subclass, and opt in this one window explicitly.
static NSRect duetFrame(id self, SEL selector, NSRect frame, NSScreen *screen) {
    if (objc_getAssociatedObject(self, &duetFreePlacementKey)) return frame;
    return ((NSRect (*)(id, SEL, NSRect, NSScreen *))duetOriginalConstrain)(self, selector, frame, screen);
}

int duet_install_window_geometry(void *pointer) {
    if (![NSThread isMainThread] || !pointer) return 0;
    NSWindow *window = (__bridge NSWindow *)pointer;
    Class base = object_getClass(window);
    // Never alter AppKit's shared base classes.
    if (base == [NSWindow class] || base == [NSPanel class]) return 0;
    if (duetWindowClass && duetWindowClass != base) return 0;
    if (!duetWindowClass) {
        SEL selector = @selector(constrainFrameRect:toScreen:);
        Method method = class_getInstanceMethod(base, selector);
        if (!method) return 0;
        duetOriginalConstrain = method_getImplementation(method);
        const char *types = method_getTypeEncoding(method);
        if (!class_addMethod(base, selector, (IMP)duetFrame, types))
            class_replaceMethod(base, selector, (IMP)duetFrame, types);
        duetWindowClass = base;
    }
    objc_setAssociatedObject(window, &duetFreePlacementKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    // This is a floating companion, not a document window. Amethyst (and other
    // AX window managers) only tile AXStandardWindow; always-on-top alone is
    // insufficient. Keep its accessibility controls exposed and usable.
    window.accessibilitySubrole = NSAccessibilityFloatingWindowSubrole;
    return 1;
}

// AppKit's interactive window drag clamps the transparent frame even when
// constrainFrameRect: is overridden. Track this mouse gesture in screen points
// instead, preserving the exact cursor-to-character offset across monitors.
int duet_begin_window_drag(void *pointer) {
    if (![NSThread isMainThread] || !pointer) return 0;
    NSWindow *window = (__bridge NSWindow *)pointer;
    if (!([NSEvent pressedMouseButtons] & 1)) return 0;
    NSPoint startMouse = [NSEvent mouseLocation];
    NSPoint startOrigin = window.frame.origin;
    __weak NSWindow *weakWindow = window;
    __block id monitor = nil;
    monitor = [NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp)
        handler:^NSEvent *(NSEvent *event) {
            NSWindow *current = weakWindow;
            if (event.type == NSEventTypeLeftMouseUp || !current) {
                [NSEvent removeMonitor:monitor];
                monitor = nil;
                return event;
            }
            NSPoint mouse = [NSEvent mouseLocation];
            [current setFrameOrigin:NSMakePoint(startOrigin.x + mouse.x - startMouse.x,
                                                startOrigin.y + mouse.y - startMouse.y)];
            return event;
        }];
    return monitor != nil;
}
