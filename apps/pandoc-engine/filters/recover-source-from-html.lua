-- recover-source-from-html: take an exported HTML page down to the document it was
-- exported from. Org Mode's HTML export and Hugo's output both wrap the document in
-- page chrome (navigation, preamble, postamble, scripts, styles); the document is the
-- element with id "content", its title is the page's first level-one heading, and what
-- the exporter generated rather than the author wrote (the Backlinks section, section
-- numbers, the footnote back-references) is not part of it.
--
-- Metadata in:  `recovery-mode`  "region" keeps the page as the browser shows it
--                                 (footnotes stay as the exporter laid them out) so the
--                                 recovered text can be compared with it;
--                                "recover" turns the exporter's footnote markup into notes.
-- Metadata out: `title`, `date` (a string, when the page opens with a `#+date` line),
--               `keywords` (a list, from the page's tag links).
-- Links are rewritten by the caller, which knows where every page now lives.

local stringify = pandoc.utils.stringify

local mode = "recover"
local title_dropped = false

local function plain(value) return stringify(value) end

local function find_content(blocks)
  local found
  pandoc.walk_block(pandoc.Div(blocks), {
    Div = function(div)
      if found == nil and div.identifier == "content" then found = div end
    end,
  })
  if found == nil then
    -- Hugo list pages keep their listing in an unnamed <main>.
    pandoc.walk_block(pandoc.Div(blocks), {
      Div = function(div)
        if found == nil and div.attributes["role"] == "main" then found = div end
      end,
    })
  end
  return found
end

local function first_title(blocks)
  local title
  pandoc.walk_block(pandoc.Div(blocks), {
    Header = function(header)
      if title == nil and header.level == 1 then title = header end
    end,
  })
  return title
end

local function page_tags(blocks)
  local tags = {}
  pandoc.walk_block(pandoc.Div(blocks), {
    Span = function(span)
      if span.classes:includes("page-tags") then
        pandoc.walk_inline(span, {
          Link = function(link) tags[#tags + 1] = plain(link.content) end,
        })
      end
    end,
  })
  return tags
end

local export_chrome = { content = true, section = true, status = true }
local function is_chrome_div(div)
  if #div.classes == 0 then return true end
  for _, class in ipairs(div.classes) do
    if not (export_chrome[class] or class:match("^outline%-%d$") or class:match("^outline%-text%-%d$")
        or class == "footdef" or class == "footpara" or class == "footnotes") then
      return false
    end
  end
  return true
end

local function footnote_number(identifier)
  return identifier:match("^fn%.(.+)$") or identifier:match("^fnr%.(.+)$")
end

-- The definitions the exporter collected at the end of the page: number -> blocks.
local function collect_footnotes(content)
  local definitions = {}
  pandoc.walk_block(pandoc.Div(content), {
    Div = function(div)
      if div.classes:includes("footdef") then
        local number, body
        pandoc.walk_block(div, {
          Link = function(link)
            if number == nil and link.classes:includes("footnum") then number = footnote_number(link.identifier) end
          end,
        })
        for _, block in ipairs(div.content) do
          if block.t == "Div" and block.classes:includes("footpara") then body = block.content end
        end
        if number and body then definitions[number] = body end
      end
    end,
  })
  return definitions
end

function Pandoc(doc)
  local meta = doc.meta
  mode = meta["recovery-mode"] and plain(meta["recovery-mode"]) or "recover"

  local content = find_content(doc.blocks)
  if content == nil then
    io.stderr:write("recover-source-from-html: no element with id \"content\"\n")
    os.exit(3)
  end
  local title_header = first_title(doc.blocks)
  local body = content.content
  local keywords = page_tags(doc.blocks)

  local footnotes = {}
  if mode == "recover" then footnotes = collect_footnotes(body) end

  local filter = {
    Header = function(header)
      if header.classes:includes("footnotes") then return {} end
      if not title_dropped and title_header and header.level == 1 and plain(header) == plain(title_header) then
        title_dropped = true
        return {}
      end
      header.attr = pandoc.Attr("", {}, {})
      return header
    end,
    Span = function(span)
      for _, class in ipairs(span.classes) do
        if class:match("^section%-number") then return {} end
        if class == "timestamp-wrapper" or class == "timestamp" then return span.content end
      end
      return span
    end,
    Div = function(div)
      if (div.identifier == "footnotes" or div.classes:includes("footnotes")) and mode == "recover" then return {} end
      local first = div.content[1]
      if first and first.t == "Header" and plain(first.content) == "Backlinks" then return {} end
      if #div.content == 0 then return {} end
      if is_chrome_div(div) then return div.content end
      return div
    end,
  }
  if mode == "recover" then
    filter.Superscript = function(sup)
      -- Pandoc reads `<sup>1</sup><sup>, </sup>` as one superscript holding the reference and a comma.
      local only = sup.content[1]
      if only and only.t == "Link" and only.classes:includes("footref") then
        local rest = {}
        for i = 2, #sup.content do rest[#rest + 1] = sup.content[i] end
        local separator = plain(pandoc.Inlines(rest)):gsub("%s", "")
        local note = footnotes[footnote_number(only.identifier)]
        if note and (separator == "" or separator == ",") then return pandoc.Note(note) end
        return sup
      end
      if plain(sup):gsub("%s", "") == "," then return {} end
      return sup
    end
  end

  local blocks = pandoc.walk_block(pandoc.Div(body), filter).content
  -- The page title was the level-one heading; the document's own headings start at level one.
  local shallowest = 7
  for _, block in ipairs(pandoc.walk_block(pandoc.Div(blocks), {}).content) do
    if block.t == "Header" and block.level < shallowest then shallowest = block.level end
  end
  if shallowest > 1 and shallowest < 7 then
    blocks = pandoc.walk_block(pandoc.Div(blocks), {
      Header = function(header) header.level = header.level - (shallowest - 1); return header end,
    }).content
  end
  -- Hugo pages keep the title above the content region; Org pages keep it inside.
  local title = title_header and title_header.content or meta.title or pandoc.Inlines({})

  -- A line that opens `#+word` is an Org keyword the author wrote without its colon; the exporter
  -- printed it as prose.  Keep the line verbatim as a raw Org line, so Org reads it as it did.
  local kept = {}
  for _, block in ipairs(blocks) do
    local lead_text = block.t == "Para" and block.content[1] and block.content[1].t == "Str" and block.content[1].text
    if lead_text and lead_text:match("^#%+%a") and not lead_text:match("^#%+date$") then
      local line, rest, broke = {}, {}, false
      for _, inline in ipairs(block.content) do
        if broke then rest[#rest + 1] = inline
        elseif inline.t == "SoftBreak" or inline.t == "LineBreak" then broke = true
        else line[#line + 1] = inline end
      end
      kept[#kept + 1] = pandoc.RawBlock("org", plain(pandoc.Inlines(line)))
      if #rest > 0 then kept[#kept + 1] = pandoc.Para(rest) end
    else
      kept[#kept + 1] = block
    end
  end
  blocks = kept

  -- A first line `#+date <timestamp>` is a keyword the author wrote, not prose.
  local date
  local lead = blocks[1]
  if lead and lead.t == "Para" and lead.content[1] and lead.content[1].t == "Str" and lead.content[1].text == "#+date" then
    local rest = {}
    for i = 2, #lead.content do rest[#rest + 1] = lead.content[i] end
    date = plain(pandoc.Inlines(rest)):gsub("^%s+", ""):gsub("%s+$", "")
    table.remove(blocks, 1)
  end

  local out_meta = pandoc.Meta({})
  out_meta.title = title
  if date then out_meta.date = pandoc.MetaString(date) end
  if #keywords > 0 then
    local list = pandoc.MetaList({})
    for _, keyword in ipairs(keywords) do list[#list + 1] = pandoc.MetaString(keyword) end
    out_meta.keywords = list
  end
  return pandoc.Pandoc(blocks, out_meta)
end
