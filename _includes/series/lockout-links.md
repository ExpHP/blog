{%- comment -%}{% raw %}

  Generates markdown reference-style intra-series links for the
  Lockout! series, to be used like [link text][Part 2].

  We can't use a liquid variable in {% post_url %} so we have
  to do some silly O(N) lookup through every post on the site
  for each post in the series.
  
{% endraw %}{%- endcomment -%}

{%- capture newline %}
{% endcapture -%}
{%- for group in site.data.series.lockout -%}
  {%- for item in group.items -%}
    {%- for site_post in site.posts -%}
      {%- if
        site_post.series == page.series
        and site_post.series-part-id == item.series-part-id
      -%}
{{- newline -}}
[Part {{ item.series-part-id }}]: {{ site_post.url }}
      {%- break -%}
      {%- endif -%}
    {%- endfor -%}
  {%- endfor -%}
{%- endfor -%}
