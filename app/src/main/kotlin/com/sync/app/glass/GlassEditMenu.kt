package com.sync.app.glass

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.util.lerp
import com.kyant.backdrop.Backdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.colorControls
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.highlight.Highlight
import com.kyant.shapes.RoundedRectangle

/**
 * 플레이리스트 곡 편집 모드(edit)의 Context Menu — 곡 삭제 / 곡 즐겨찾기.
 *
 * 기존 SYNC 컨텍스트 메뉴/다이얼로그와 같은 Kyant 글래스(colorControls + blur + lens(depthEffect) + Plain highlight,
 * 어두운 Container 틴트)를 그대로 쓴다. 위치/크기는 DOM(sync-ux.js)이 곡 행 옆에 계산해 준 rect 를 따른다.
 * 곡을 끌어 정렬하는 동안에는 show=false → 스프링으로 사라졌다가, 놓으면 새 위치에서 다시 나타난다.
 */

private fun editPath(d: String): Path = PathParser().parsePathString(d).toPath()

private val TrashIcon by lazy {
    listOf(editPath("M3.5 5.5h13"), editPath("M7.5 5.5V3.5h5v2"), editPath("M5 5.5l.8 10.5h8.4l.8-10.5"), editPath("M8.2 8.8v4.4"), editPath("M11.8 8.8v4.4"))
}

/** 메뉴 몸통에서 일어난 탭이 뒤의 DOM 으로 새어 나가지 않게 소비한다. */
private val EditMenuNoTouchThrough: Modifier = Modifier.pointerInput(Unit) { detectTapGestures { } }

@Composable
internal fun EditMenuGlass(e: EditState, backdrop: Backdrop, c: GlassController) {
    val vis = remember { Animatable(0f) }
    LaunchedEffect(e.show) { vis.animateTo(if (e.show) 1f else 0f, spring(0.74f, 480f, 0.001f)) }
    // 완전히 사라진 뒤에는 컴포지션에서 빼서 터치/그리기 비용을 없앤다 (임계값을 넘을 때만 recompose)
    val alive by remember { derivedStateOf { vis.value > 0.01f } }
    if (!alive && !e.show) return

    val accent = LocalGlassAccent.current
    val originY = if (e.up) 1f else 0f

    Box(Modifier.cssRect(e.rect)) {
        Column(
            Modifier
                .fillMaxSize()
                .drawBackdrop(
                    backdrop = backdrop,
                    shape = { RoundedRectangle(24.dp) },
                    effects = {
                        colorControls(brightness = 0f, saturation = 1.5f)
                        blur(3f.dp.toPx())
                        lens(16f.dp.toPx(), 32f.dp.toPx(), depthEffect = true)
                    },
                    highlight = { Highlight.Plain },
                    layerBlock = {
                        val v = vis.value.coerceIn(0f, 1f)
                        val s = lerp(0.84f, 1f, v)
                        scaleX = s; scaleY = s; alpha = v
                        transformOrigin = TransformOrigin(0.86f, originY)
                    },
                    onDrawSurface = { drawRect(GlassTheme.Container) }
                )
                .then(if (e.show) EditMenuNoTouchThrough else Modifier)
                .clip(RoundedRectangle(24.dp))
                .padding(vertical = 4.dp)
        ) {
            EditRow(
                label = e.favLabel, color = GlassTheme.Content, enabled = e.show,
                onClick = { c.cmd { put("t", "edit"); put("a", "fav") } }
            ) {
                Canvas(Modifier.size(20.dp)) {
                    if (e.fav) fillIcon(GlassIcons.Fav[0], 20f, accent)
                    strokeIcon(GlassIcons.Fav, 20f, if (e.fav) accent else GlassTheme.Content, 1.6f)
                }
            }
            Box(
                Modifier.padding(horizontal = 16.dp).fillMaxWidth().height(0.5.dp)
                    .background(Color.White.copy(0.18f))
            )
            EditRow(
                label = e.delLabel, color = GlassTheme.Danger, enabled = e.show,
                onClick = { c.cmd { put("t", "edit"); put("a", "del") } }
            ) {
                Canvas(Modifier.size(20.dp)) { strokeIcon(TrashIcon, 20f, GlassTheme.Danger, 1.6f) }
            }
        }
    }
}

@Composable
private fun EditRow(
    label: String,
    color: Color,
    enabled: Boolean,
    onClick: () -> Unit,
    icon: @Composable () -> Unit
) {
    var pressed by remember { mutableStateOf(false) }
    val click by rememberUpdatedState(onClick)
    val on by rememberUpdatedState(enabled)
    Row(
        Modifier
            .fillMaxWidth()
            .height(50.dp)
            .background(if (pressed) Color.White.copy(0.10f) else Color.Transparent)
            .pointerInput(Unit) {
                detectTapGestures(
                    onPress = { if (on) { pressed = true; tryAwaitRelease(); pressed = false } },
                    onTap = { if (on) click() }
                )
            }
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        icon()
        Spacer(Modifier.width(12.dp))
        BasicText(
            label, maxLines = 1, overflow = TextOverflow.Ellipsis,
            style = TextStyle(color, 16.sp, FontWeight.Medium)
        )
    }
}
