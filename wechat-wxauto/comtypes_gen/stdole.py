from enum import IntFlag

import comtypes.gen._00020430_0000_0000_C000_000000000046_0_2_0 as __wrapper_module__
from comtypes.gen._00020430_0000_0000_C000_000000000046_0_2_0 import (
    OLE_OPTEXCLUSIVE, COMMETHOD, CoClass, FONTUNDERSCORE, StdPicture,
    OLE_XPOS_CONTAINER, IDispatch, OLE_XSIZE_CONTAINER, Checked,
    FONTSTRIKETHROUGH, FONTSIZE, OLE_COLOR, StdFont, OLE_XSIZE_PIXELS,
    DISPPROPERTY, OLE_YPOS_HIMETRIC, Picture, Default, VgaColor,
    Library, HRESULT, Color, DISPMETHOD, OLE_HANDLE,
    OLE_YSIZE_HIMETRIC, OLE_YSIZE_CONTAINER, IEnumVARIANT, _lcid,
    Gray, Font, OLE_YSIZE_PIXELS, OLE_ENABLEDEFAULTBOOL, EXCEPINFO,
    dispid, IFontDisp, BSTR, OLE_YPOS_CONTAINER, FONTITALIC,
    OLE_XPOS_HIMETRIC, Monochrome, Unchecked, IFont,
    OLE_XSIZE_HIMETRIC, OLE_YPOS_PIXELS, typelib_path, IPictureDisp,
    FONTBOLD, IFontEventsDisp, IUnknown, FontEvents, OLE_CANCELBOOL,
    OLE_XPOS_PIXELS, IPicture, _check_version, FONTNAME, DISPPARAMS,
    VARIANT_BOOL, GUID
)


class OLE_TRISTATE(IntFlag):
    Unchecked = 0
    Checked = 1
    Gray = 2


class LoadPictureConstants(IntFlag):
    Default = 0
    Monochrome = 1
    VgaColor = 2
    Color = 4


__all__ = [
    'OLE_OPTEXCLUSIVE', 'Font', 'OLE_YSIZE_PIXELS', 'FONTUNDERSCORE',
    'StdPicture', 'OLE_XPOS_CONTAINER', 'OLE_ENABLEDEFAULTBOOL',
    'OLE_XSIZE_CONTAINER', 'Checked', 'FONTSTRIKETHROUGH',
    'IFontDisp', 'OLE_YPOS_CONTAINER', 'FONTSIZE', 'OLE_COLOR',
    'FONTITALIC', 'StdFont', 'OLE_XPOS_HIMETRIC', 'Monochrome',
    'Unchecked', 'OLE_XSIZE_PIXELS', 'OLE_YPOS_HIMETRIC', 'Picture',
    'Default', 'VgaColor', 'LoadPictureConstants', 'Library', 'IFont',
    'OLE_TRISTATE', 'OLE_XSIZE_HIMETRIC', 'OLE_YPOS_PIXELS',
    'typelib_path', 'IPictureDisp', 'Color', 'FONTBOLD',
    'IFontEventsDisp', 'OLE_HANDLE', 'OLE_YSIZE_HIMETRIC',
    'FontEvents', 'OLE_CANCELBOOL', 'OLE_YSIZE_CONTAINER',
    'OLE_XPOS_PIXELS', 'IPicture', 'FONTNAME', 'Gray'
]

