//! The bits of the macOS Accessibility API Eshlik reads other apps through: the
//! dictionary's correction watch (crate::dictionary::watch) and the check for a text
//! field before pasting (crate::paste_target).

use std::ffi::c_void;

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::string::{CFString, CFStringRef};

pub type AXUIElementRef = *const c_void;
pub type AXValueRef = *const c_void;

#[repr(C)]
#[derive(Default, Clone, Copy)]
pub struct CFRange {
    pub location: isize,
    pub length: isize,
}

pub const K_AX_VALUE_CF_RANGE_TYPE: u32 = 4;
/// The element has no value for the attribute (an app with nothing focused).
pub const K_AX_ERROR_NO_VALUE: i32 = -25212;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    pub fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    pub fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> i32;
    pub fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    pub fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut u8,
    ) -> i32;
    pub fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_seconds: f32) -> i32;
    pub fn AXValueGetValue(value: AXValueRef, the_type: u32, value_ptr: *mut c_void) -> bool;
}

/// An attribute's value, or the AXError the app answered with.
pub fn copy_attribute(element: AXUIElementRef, name: &'static str) -> Result<CFType, i32> {
    let name = CFString::from_static_string(name);
    let mut value: CFTypeRef = std::ptr::null();
    let err =
        unsafe { AXUIElementCopyAttributeValue(element, name.as_concrete_TypeRef(), &mut value) };
    match err {
        0 if !value.is_null() => Ok(unsafe { CFType::wrap_under_create_rule(value) }),
        0 => Err(K_AX_ERROR_NO_VALUE),
        e => Err(e),
    }
}

pub fn attribute(element: AXUIElementRef, name: &'static str) -> Option<CFType> {
    copy_attribute(element, name).ok()
}

pub fn is_settable(element: AXUIElementRef, name: &'static str) -> bool {
    let name = CFString::from_static_string(name);
    let mut settable = 0u8;
    let err = unsafe {
        AXUIElementIsAttributeSettable(element, name.as_concrete_TypeRef(), &mut settable)
    };
    err == 0 && settable != 0
}
