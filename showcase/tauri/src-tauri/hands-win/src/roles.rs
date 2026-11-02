// UI Automation control types, named like the macOS helper's roles.

pub const BUTTON: i32 = 50000;
pub const CHECKBOX: i32 = 50002;
pub const COMBOBOX: i32 = 50003;
pub const EDIT: i32 = 50004;
pub const HYPERLINK: i32 = 50005;
pub const LIST_ITEM: i32 = 50007;
pub const MENU_ITEM: i32 = 50011;
pub const RADIO: i32 = 50013;
pub const SLIDER: i32 = 50015;
pub const SPINNER: i32 = 50016;
pub const TAB_ITEM: i32 = 50019;
pub const TEXT: i32 = 50020;
pub const DOCUMENT: i32 = 50030;
pub const SPLIT_BUTTON: i32 = 50031;

/// UIA HeadingLevel_None; anything above it is a heading.
pub const HEADING_NONE: i32 = 80050;

/// Controls listed by `ui`.
pub fn interactive(ct: i32) -> bool {
    matches!(ct, BUTTON | CHECKBOX | COMBOBOX | EDIT | HYPERLINK | MENU_ITEM | RADIO | SLIDER | SPINNER | TAB_ITEM | SPLIT_BUTTON)
}

pub fn name(ct: i32, password: bool, heading: bool) -> &'static str {
    if heading {
        return "heading";
    }
    match ct {
        BUTTON => "button",
        CHECKBOX => "checkbox",
        COMBOBOX => "combo box",
        EDIT if password => "password field",
        EDIT => "text field",
        HYPERLINK => "link",
        MENU_ITEM => "menu item",
        RADIO => "radio",
        SLIDER => "slider",
        SPINNER => "stepper",
        TAB_ITEM => "tab",
        SPLIT_BUTTON => "menu button",
        TEXT => "text",
        DOCUMENT => "document",
        LIST_ITEM => "list item",
        50006 => "image",
        50008 => "list",
        50009 => "menu",
        50010 => "menu bar",
        50012 => "progress bar",
        50014 => "scroll bar",
        50017 => "status bar",
        50018 => "tab group",
        50021 => "toolbar",
        50022 => "tooltip",
        50023 => "tree",
        50024 => "tree item",
        50026 => "group",
        50028 => "table",
        50029 => "row",
        50032 => "window",
        50033 => "pane",
        50034 => "header",
        50035 => "column header",
        50036 => "table",
        50037 => "title bar",
        _ => "element",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_the_macos_roles() {
        assert_eq!(name(EDIT, true, false), "password field");
        assert_eq!(name(EDIT, false, false), "text field");
        assert_eq!(name(HYPERLINK, false, false), "link");
        assert_eq!(name(TEXT, false, true), "heading");
        assert_eq!(name(SPINNER, false, false), "stepper");
        assert!(interactive(HYPERLINK) && interactive(TAB_ITEM) && !interactive(TEXT) && !interactive(DOCUMENT));
    }
}
