#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <SystemConfiguration/SystemConfiguration.h>
#include <pwd.h>
#include <unistd.h>

int main(void) {
  @autoreleasepool {
    NSDictionary<NSString *, NSString *> *env = NSProcessInfo.processInfo.environment;
    NSString *runnerHome = [@"/Users" stringByAppendingPathComponent:@"runner"];
    struct passwd *user = getpwuid(getuid());
    if (!user || getuid() == 0 || strcmp(user->pw_name, "runner") != 0 ||
        strcmp(user->pw_dir, runnerHome.fileSystemRepresentation) != 0 ||
        ![env[@"HOME"] isEqualToString:runnerHome] ||
        ![env[@"GITHUB_ACTIONS"] isEqualToString:@"true"] ||
        ![env[@"RUNNER_ENVIRONMENT"] isEqualToString:@"github-hosted"] ||
        ![env[@"GITHUB_REPOSITORY"] isEqualToString:@"TunneldeDev/Tunnelde"] ||
        ![env[@"GITHUB_EVENT_NAME"] isEqualToString:@"workflow_dispatch"] ||
        ![env[@"MACOS_OTA_ACK"] isEqualToString:@"probe-only"]) {
      fputs("Refusing a non-hosted or unacknowledged GUI probe\n", stderr);
      return 2;
    }
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    uid_t consoleUID = (uid_t)-1;
    gid_t consoleGID = (gid_t)-1;
    NSString *consoleUser = CFBridgingRelease(
        SCDynamicStoreCopyConsoleUser(NULL, &consoleUID, &consoleGID));
    NSDictionary *result = @{
      @"schemaVersion": @1,
      @"consoleUserMatches": @([consoleUser isEqualToString:@"runner"] && consoleUID == getuid()),
      @"onConsole": @([session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue]),
      @"loginDone": @([session[(__bridge NSString *)kCGSessionLoginDoneKey] boolValue]),
      @"screenCount": @(NSScreen.screens.count),
      @"accessibilityTrusted": @(AXIsProcessTrusted()),
      @"screenCaptureAllowed": @(CGPreflightScreenCaptureAccess()),
    };
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:result
                                                 options:NSJSONWritingPrettyPrinted
                                                   error:&error];
    if (!json) {
      fputs("Native probe could not encode its capability report\n", stderr);
      return 1;
    }
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
  }
  return 0;
}
