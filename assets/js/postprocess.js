---
---

// postprocess.js
//
// For NON-ESSENTIAL (styling) features of ExpHP.github.io that cannot be accomplished through
// CSS alone as they require DOM modification.
//
// I rather wish I could use Jekyll plugins so that liquid templates could generate the DOM, and
// the CSS and data could be kept nearby... but GitHub pages uses a plugin whitelist.

(function() {
    // prefixes image credit info with "Image credit: "
    window.addEventListener("DOMContentLoaded", function(event) {
        for (let match of document.querySelectorAll(".post-content .figure div.credit")) {
            let strong = document.createElement("strong");
            let text = document.createTextNode("Image credit: ");
            strong.appendChild(text);
            match.insertBefore(strong, match.firstChild);
        }
    })

    // permalinks in section headers so you can right click them.
    // (kramdown just generates <h3 id="...">Text</h3)
    window.addEventListener("DOMContentLoaded", function(event) {
        for (let elem_type of ["h2", "h3", "h4", "h5"]) {
            for (let h of document.querySelectorAll(".post-content " + elem_type)) {
                let children = [];
                while (h.firstChild) {
                    children.push(h.removeChild(h.firstChild));
                }

                let anchor = h.appendChild(document.createElement("a"));
                for (let child of children) {
                    anchor.appendChild(child);
                }
                anchor.href = "#" + h.id;
            }
        }
    })

    // for custom link anchors with no associated header;
    // add a little link icon that floats in the text gutter.
    //
    // Usage (in markdown, at beginning of paragraph):
    //
    //     <span class="anchor" id="tag-for-permalink"></span>
    //     Paragraph text blah blah
    //
    // A span is used rather than div so that the markdown renderer puts it inside the <p>,
    // which is a requirement of the CSS used to push it into the gutter.
    window.addEventListener("DOMContentLoaded", function(event) {
        for (let div of document.querySelectorAll(".post-content span.anchor")) {
            let anchor = div.appendChild(document.createElement("a"));
            let img = anchor.appendChild(document.createElement("img"));
            anchor.href = "#" + div.id;
            img.src = "{{ '/assets/img/meta/permalink.png' | relative_url }}";
        }
    })
})()
